// XRA-lite: hand placement and hand contact correction
//
// Problem: XR Animator retargets arms by joint direction. When the user's proportions differ from the
// avatar's (long arms, wide shoulders), the avatar's hands land at the wrong height/width, and poses where
// the hands touch (heart, clap, prayer) open a gap, even though MediaPipe tracks the real hands correctly.
//
// Fix, applied every frame right before drawing (event "XRA_after_update_model" in MMD_SA.render):
//  a. Placement: real wrists are expressed in the user's own body frame (sideways in shoulder widths,
//     vertical in shoulder-line-to-nose heights) and re-applied in the avatar's body frame. Only sideways
//     and vertical are corrected; the avatar keeps its own depth (webcam depth is the least reliable).
//  b. Contact: when the real hands are close, the avatar's wrist gap is matched to the real gap in palm units.
// Both use a two-bone solve (shoulder swing + elbow hinge) and keep each hand's world orientation.
//
// The bones edited are the ones the rest of XR Animator drives (normalized humanoid bones on VRM 1.0), and
// the result is pushed to the raw bones, so the OBS capture and the VMC output (Warudo) get the same pose.
//
// Live tuning: window.XRA_hand_contact.config (Ctrl+Shift+I console).

(function () {
  const CFG = {
// placement
    place_strength: 0.85,  // 0..1, how strongly hands move to the proportion-corrected position
    place_smooth: 0.5,     // 0..1 per frame, smoothing of placement targets (higher = snappier)
    scale_adapt: 0.02,     // 0..1 per frame, how fast body-proportion measurements adapt (low = stable)
    flip_margin: 0.25,     // mirroring/assignment choice only switches if the other is this much better
// contact
    near: 0.6,             // real wrist gap (palm units) at/below which contact correction is full strength
    far: 1.6,              // real wrist gap (palm units) at/above which contact correction is off
    blend: 0.35,           // 0..1 per frame, smoothing of the contact weight
    max_move: 2.0,         // safety: max contact move per side, in avatar palm units
// solver
    iterations: 4,
    elbow_min: 0.03,       // rad, elbow almost straight
    elbow_max: 2.7,        // rad, elbow fully bent (~155 deg)
// data
    stale_ms: 250,         // ignore tracking results older than this
    min_score: 0.5,        // min landmark confidence for placement
  };

  const S = {
    hands: null, t_hands: 0,
    pose3D: null, t_pose: 0,
    weight: 0,
    place_prev: null,
    choice: null,          // [sign, swap] of the current mirroring/assignment choice
    scale: { real_sw: 0, real_th: 0, av_sw: 0, av_th: 0 },
  };

// ---------------------------------------------------------------------------------------------------
// 1. Capture tracking results from the pose worker (no changes to the minified core needed)
  const _Worker = window.Worker;
  function XRA_Worker(url, options) {
    const w = new _Worker(url, options);
    if (/pose_worker\.js/.test(String(url))) {
      w.addEventListener('message', (e) => {
        const d = e.data;
        if ((typeof d != 'string') || (d.indexOf('"posenet"') == -1)) return;
        let o;
        try { o = JSON.parse(d); } catch (err) { return; }
        const now = performance.now();
        if (Array.isArray(o.handpose)) { S.hands = o.handpose; S.t_hands = now; }
        if (o.posenet?.keypoints3D?.length >= 33) { S.pose3D = o.posenet.keypoints3D; S.t_pose = now; }
      });
    }
    return w;
  }
  XRA_Worker.prototype = _Worker.prototype;
  window.Worker = XRA_Worker;

// ---------------------------------------------------------------------------------------------------
// math scratch objects (created once, on first use, from the modern three.js used by the VRM)
  let T, v1, v2, v3, v4, v5, n1, q1, q2, q3, q_hand;
  function init_math() {
    T = MMD_SA.THREEX.THREE;
    [v1, v2, v3, v4, v5, n1] = Array.from({length:6}, ()=>new T.Vector3());
    [q1, q2, q3, q_hand] = Array.from({length:4}, ()=>new T.Quaternion());
  }
  const P = { L: null, R: null, tL: null, tR: null, cL: null, cR: null, mid: null, dir: null };
  function init_vectors() { for (const k in P) P[k] = new T.Vector3(); }

  function dist2D(a, b) { const dx = a[0]-b[0], dy = a[1]-b[1]; return Math.sqrt(dx*dx + dy*dy); }
  function smoothstep(e0, e1, x) { const t = Math.min(Math.max((x-e0)/(e1-e0), 0), 1); return t*t*(3-2*t); }
  function ema(prev, v, a) { return (prev > 0) ? prev + (v - prev) * a : v; }

// ---------------------------------------------------------------------------------------------------
// 2. Two-bone solver: shoulder swing (minimal rotation, no twist) + elbow hinge (stays in its bend plane)

// apply a world-space rotation `dq` to `joint` (converted into its parent space)
  function apply_world_rotation(joint, dq) {
    joint.parent.getWorldQuaternion(q2);
    q3.copy(q2).invert().multiply(dq).multiply(q2);
    joint.quaternion.premultiply(q3).normalize();
    joint.updateMatrixWorld(true);
  }

  function swing_shoulder(upper, hand, target) {
    upper.getWorldPosition(v1);
    hand.getWorldPosition(v2);
    const a = v3.subVectors(v2, v1), b = v4.subVectors(target, v1);
    if ((a.lengthSq() < 1e-10) || (b.lengthSq() < 1e-10)) return;
    a.normalize(); b.normalize();
    if (a.dot(b) > 0.9999999) return;
    apply_world_rotation(upper, q1.setFromUnitVectors(a, b));
  }

// bend the elbow (hinge about its current bend axis) so the shoulder-hand distance matches the target
  function bend_elbow(upper, lower, hand, target) {
    upper.getWorldPosition(v1);   // shoulder
    lower.getWorldPosition(v2);   // elbow
    hand.getWorldPosition(v3);    // wrist
    const u = v4.subVectors(v2, v1), f = v5.subVectors(v3, v2);
    const lu = u.length(), lf = f.length();
    if ((lu < 1e-6) || (lf < 1e-6)) return;
    u.divideScalar(lu); f.divideScalar(lf);

    n1.crossVectors(u, f);
    if (n1.lengthSq() < 1e-8) return;   // fully straight: bend axis undefined, leave it to the swing
    n1.normalize();

// current bend angle (0 = straight) and the angle needed to reach the target distance (law of cosines)
    const bend = Math.acos(Math.min(Math.max(u.dot(f), -1), 1));
    const d = Math.min(Math.max(v1.distanceTo(target), Math.abs(lu - lf) + 1e-6), lu + lf - 1e-6);
    const interior = Math.acos(Math.min(Math.max((lu*lu + lf*lf - d*d) / (2*lu*lf), -1), 1));
    const bend_target = Math.min(Math.max(Math.PI - interior, CFG.elbow_min), CFG.elbow_max);

    const delta = bend_target - bend;
    if (Math.abs(delta) < 1e-5) return;
    apply_world_rotation(lower, q1.setFromAxisAngle(n1, delta));
  }

  function solve_arm(arm, target) {
    arm.hand.getWorldQuaternion(q_hand);   // keep the hand's world orientation (finger poses stay intact)
    for (let i = 0; i < CFG.iterations; i++) {
      bend_elbow(arm.upper, arm.lower, arm.hand, target);
      swing_shoulder(arm.upper, arm.hand, target);
    }
    arm.hand.parent.getWorldQuaternion(q2);
    arm.hand.quaternion.copy(q2.invert().multiply(q_hand));
    arm.hand.updateMatrixWorld(true);
  }

// ---------------------------------------------------------------------------------------------------
// 3. Placement

  function score_ok(k, i) { return (k[i].score == null) || (k[i].score >= CFG.min_score); }

// user's body frame from pose 3D keypoints (BlazePose: 0 nose, 11/12 shoulders, 15/16 wrists)
  function body_frame_real(k) {
    if (![2, 5, 11, 12, 15, 16].every(i=>score_ok(k, i))) return null;
    const V = (i)=>new T.Vector3(k[i].x, k[i].y, k[i].z);
    const shL = V(11), shR = V(12), eyes = V(2).add(V(5)).multiplyScalar(0.5); // same anatomical point as the avatar (eye midpoint)
    const mid = shL.clone().add(shR).multiplyScalar(0.5);
    const X = shR.clone().sub(shL);
    const sw = X.length();
    if (!(sw > 1e-6)) return null;
    X.divideScalar(sw);
    const Y = eyes.sub(mid);
    Y.addScaledVector(X, -Y.dot(X));
    const th = Y.length();
    if (!(th > 1e-6)) return null;
    Y.divideScalar(th);
    return { mid, X, Y, sw, th, wrists: [V(15), V(16)] };
  }

// avatar's body frame from its bones (shoulders = upper arm roots, head)
  function body_frame_avatar(arms, head_refs) {
    const shL = arms.left.upper.getWorldPosition(new T.Vector3());
    const shR = arms.right.upper.getWorldPosition(new T.Vector3());
    const mid = shL.clone().add(shR).multiplyScalar(0.5);
    const X = shR.sub(shL);
    const sw = X.length();
    if (!(sw > 1e-6)) return null;
    X.divideScalar(sw);
    const Y = head_refs.reduce((acc, b)=>acc.add(b.getWorldPosition(v1)), new T.Vector3()).divideScalar(head_refs.length).sub(mid);
    Y.addScaledVector(X, -Y.dot(X));
    const th = Y.length();
    if (!(th > 1e-6)) return null;
    Y.divideScalar(th);
    const Z = new T.Vector3().crossVectors(X, Y).normalize();
    return { mid, X, Y, Z, sw, th };
  }

  function place_hands(arms, head_refs) {
    const now = performance.now();
    if (!S.pose3D || (now - S.t_pose > CFG.stale_ms)) { S.place_prev = null; return; }
    const R = body_frame_real(S.pose3D);
    const A = body_frame_avatar(arms, head_refs);
    if (!R || !A) { S.place_prev = null; return; }

// proportions don't change: average them slowly so head nods / shrugs don't rescale the hands
    const sc = S.scale;
    sc.real_sw = ema(sc.real_sw, R.sw, CFG.scale_adapt);
    sc.real_th = ema(sc.real_th, R.th, CFG.scale_adapt);
    sc.av_sw   = ema(sc.av_sw,   A.sw, CFG.scale_adapt);
    sc.av_th   = ema(sc.av_th,   A.th, CFG.scale_adapt);

// real wrists in normalized body coordinates [sideways, up]
    const norm = R.wrists.map(w=>{
      const d = w.sub(R.mid);
      return [d.dot(R.X) / sc.real_sw, d.dot(R.Y) / sc.real_th];
    });

    arms.left.hand.getWorldPosition(P.cL);
    arms.right.hand.getWorldPosition(P.cR);

    const target = (out, n, sign, cur)=>{
      const depth = v1.subVectors(cur, A.mid).dot(A.Z);
      return out.copy(A.mid)
        .addScaledVector(A.X, sign * n[0] * sc.av_sw)
        .addScaledVector(A.Y, n[1] * sc.av_th)
        .addScaledVector(A.Z, depth);
    };

// Resolve mirroring (sideways sign) and which real wrist drives which avatar arm by comparing with the
// current direction-retargeted pose (which already crosses correctly when the user crosses arms).
// Decided only while the hands are clearly apart sideways (unambiguous), then locked, with hysteresis.
    const options = [];
    for (const sign of [1, -1]) {
      for (const swap of [false, true]) {
        const nL = norm[swap ? 1 : 0], nR = norm[swap ? 0 : 1];
        const tL = target(new T.Vector3(), nL, sign, P.cL), tR = target(new T.Vector3(), nR, sign, P.cR);
        options.push({ key: sign + (swap ? 's' : ''), tL, tR, cost: tL.distanceTo(P.cL) + tR.distanceTo(P.cR) });
      }
    }
    const apart = Math.abs(norm[0][0] - norm[1][0]) > 0.6;
    const prev = S.choice && options.find(o=>o.key == S.choice);
    let pick;
    if (prev && !apart) {
      pick = prev;
    }
    else {
      options.sort((a, b)=>a.cost - b.cost);
      pick = (prev && (prev.cost <= options[0].cost * (1 + CFG.flip_margin))) ? prev : options[0];
    }
    if (S.choice && (S.choice != pick.key)) S.place_prev = null; // don't sweep targets across the body
    S.choice = pick.key;

// smooth targets
    if (S.place_prev) {
      pick.tL.lerpVectors(S.place_prev[0], pick.tL, CFG.place_smooth);
      pick.tR.lerpVectors(S.place_prev[1], pick.tR, CFG.place_smooth);
    }
    S.place_prev = [pick.tL.clone(), pick.tR.clone()];

    const k = CFG.place_strength;
    solve_arm(arms.left,  P.tL.copy(P.cL).lerp(pick.tL, k));
    solve_arm(arms.right, P.tR.copy(P.cR).lerp(pick.tR, k));
  }

// ---------------------------------------------------------------------------------------------------
// 4. Contact

// real wrist gap in palm units, or null if both hands aren't tracked
  function real_gap() {
    if (!S.hands || (performance.now() - S.t_hands > CFG.stale_ms)) return null;
    const L = S.hands.find(h=>h.label == 'Left'), R = S.hands.find(h=>h.label == 'Right');
    if (!L?.keypoints || !R?.keypoints) return null;
    const palm = (h)=>Math.max(dist2D(h.keypoints[0], h.keypoints[9]), dist2D(h.keypoints[5], h.keypoints[17]) * 1.3);
    const palm_avg = (palm(L) + palm(R)) / 2;
    if (!(palm_avg > 1)) return null;
    return dist2D(L.keypoints[0], R.keypoints[0]) / palm_avg;
  }

  function contact_hands(arms) {
    const gap = real_gap();
    const w_target = (gap != null) ? 1 - smoothstep(CFG.near, CFG.far, gap) : 0;
    S.weight += (w_target - S.weight) * CFG.blend;
    if ((S.weight < 0.01) || (gap == null)) return;

    arms.left.hand.getWorldPosition(P.L);
    arms.right.hand.getWorldPosition(P.R);

    const palm_of = (arm)=>(arm.mid) ? arm.hand.getWorldPosition(v1).distanceTo(arm.mid.getWorldPosition(v2)) : 0;
    let palm_av = (palm_of(arms.left) + palm_of(arms.right)) / 2;
    if (!(palm_av > 1e-4)) palm_av = P.L.distanceTo(P.R) * 0.1 || 0.08;

    const d_av = P.L.distanceTo(P.R);
    let move = (d_av - gap * palm_av) / 2 * S.weight;   // per side; >0 pulls together, <0 pushes apart
    const max_move = CFG.max_move * palm_av;
    move = Math.max(Math.min(move, max_move), -max_move);
    if (Math.abs(move) < palm_av * 0.01) return;

    P.dir.subVectors(P.R, P.L).normalize();
    solve_arm(arms.left,  P.tL.copy(P.L).addScaledVector(P.dir,  move));
    solve_arm(arms.right, P.tR.copy(P.R).addScaledVector(P.dir, -move));
  }

// ---------------------------------------------------------------------------------------------------
// 5. Per-frame entry point

  window.addEventListener('XRA_after_update_model', function () {
    if (!self.MMD_SA || !MMD_SA.THREEX?.enabled) return;
    const model = MMD_SA.THREEX.get_model(0);
    if (!model?.getBoneNode || !model.mesh) return;
// Only with body tracking on: XR Animator then rewrites the arm bones from scratch every frame, so
// corrections never accumulate. (With face-only tracking the arms are not rewritten.)
    if (!System._browser.camera?.ML_enabled || !System._browser.camera?.poseNet?.enabled) {
      S.weight = 0; S.place_prev = null; S.choice = null;
      return;
    }

    if (!T) { init_math(); init_vectors(); }

// the bones XR Animator drives (normalized on VRM 1.0 with auto update, raw otherwise)
    const bone = (n)=>model.getBoneNode(n);
    const arms = {};
    for (const side of ['left', 'right']) {
      const a = arms[side] = {
        upper: bone(side + 'UpperArm'),
        lower: bone(side + 'LowerArm'),
        hand:  bone(side + 'Hand'),
        mid:   bone(side + 'MiddleProximal'),
      };
      if (!a.upper || !a.lower || !a.hand) return;
    }
// vertical reference: eye midpoint (matches the user's eye landmarks); head bone if the avatar has no eye bones
    const eyeL = bone('leftEye'), eyeR = bone('rightEye'), head = bone('head');
    const head_refs = (eyeL && eyeR) ? [eyeL, eyeR] : (head ? [head] : null);
    if (!head_refs) return;

    model.mesh.updateMatrixWorld(true);

    place_hands(arms, head_refs);
    contact_hands(arms);

// push normalized -> raw so the rendered mesh (and anything reading raw bones) gets the correction
    const humanoid = model.model?.humanoid;
    if (humanoid?.autoUpdateHumanBones && (typeof humanoid.update == 'function')) humanoid.update();
  });

  self.XRA_hand_contact = { config: CFG, state: S };
})();

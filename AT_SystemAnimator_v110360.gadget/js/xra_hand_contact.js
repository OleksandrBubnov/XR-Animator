// XRA-lite: hand contact correction
//
// Problem: arms are retargeted by joint direction, so when the user's body proportions differ from the
// avatar's, poses where the hands touch (heart, clap, prayer, OK-to-hand) end up with a gap or overlap
// even though MediaPipe tracks the real hands correctly.
//
// Fix: when the real hands are close, measure the real wrist-to-wrist distance in palm units and move the
// avatar's wrists along their connecting line until their distance matches (in avatar palm units).
// A two-bone CCD solve on upper arm + forearm does the move; the hand's world orientation is preserved.
// Runs on the VRM raw bones right before drawing (event "XRA_after_update_model" in MMD_SA.render).

(function () {
  const CFG = {
    near: 0.6,       // real gap (palm units) at or below which the correction is at full strength
    far: 1.6,        // real gap (palm units) at or above which the correction is off
    blend: 0.35,     // per-frame smoothing of the correction weight (0..1)
    max_move: 2.0,   // max wrist move per side, in avatar palm units (safety)
    stale_ms: 250,   // ignore tracking results older than this
    iterations: 4,   // CCD iterations
  };

  CFG.place_strength = 0.85; // 0..1, how strongly hands are moved to the proportion-corrected position
  CFG.place_smooth = 0.5;    // per-frame smoothing of placement targets (0..1, higher = snappier)

  const S = { hands: null, pose3D: null, t: 0, weight: 0, place_prev: null };

// --- 1. capture the latest hand results from the pose worker (no changes to the minified core needed) ---
  const _Worker = window.Worker;
  function XRA_Worker(url, options) {
    const w = new _Worker(url, options);
    if (/pose_worker\.js/.test(String(url))) {
      w.addEventListener('message', (e) => {
        const d = e.data;
        if ((typeof d != 'string') || (d.indexOf('"handpose"') == -1)) return;
        try {
          const o = JSON.parse(d);
          if (Array.isArray(o.handpose)) {
            S.hands = o.handpose;
            S.t = performance.now();
          }
          if (o.posenet?.keypoints3D?.length >= 17) {
            S.pose3D = o.posenet.keypoints3D;
            S.t_pose = performance.now();
          }
        }
        catch (err) {}
      });
    }
    return w;
  }
  XRA_Worker.prototype = _Worker.prototype;
  window.Worker = XRA_Worker;

// --- helpers ---
  function dist2D(a, b) { const dx = a[0]-b[0], dy = a[1]-b[1]; return Math.sqrt(dx*dx + dy*dy); }
  function smoothstep(e0, e1, x) { const t = Math.min(Math.max((x-e0)/(e1-e0), 0), 1); return t*t*(3-2*t); }

// real gap between the hands in palm units, or null if not both hands are tracked
  function real_gap_palm_units() {
    if (!S.hands || (performance.now() - S.t > CFG.stale_ms)) return null;
    const L = S.hands.find(h=>h.label == 'Left');
    const R = S.hands.find(h=>h.label == 'Right');
    if (!L || !R || !L.keypoints || !R.keypoints) return null;

    const palm = (h)=>Math.max(dist2D(h.keypoints[0], h.keypoints[9]), dist2D(h.keypoints[5], h.keypoints[17]) * 1.3);
    const palm_avg = (palm(L) + palm(R)) / 2;
    if (!(palm_avg > 1)) return null;

    return { wrist_gap: dist2D(L.keypoints[0], R.keypoints[0]) / palm_avg };
  }

  let THREE_, v1, v2, v3, v4, q1, q2, q3, q_hand;
  function init_math() {
    THREE_ = MMD_SA.THREEX.THREE;
    v1 = new THREE_.Vector3(); v2 = new THREE_.Vector3(); v3 = new THREE_.Vector3(); v4 = new THREE_.Vector3();
    q1 = new THREE_.Quaternion(); q2 = new THREE_.Quaternion(); q3 = new THREE_.Quaternion(); q_hand = new THREE_.Quaternion();
  }

// rotate `joint` (in world space) so that `end` points toward `target`
  function rotate_toward(joint, end, target) {
    joint.getWorldPosition(v1);
    end.getWorldPosition(v2);
    const a = v3.subVectors(v2, v1);
    const b = v4.subVectors(target, v1);
    if ((a.lengthSq() < 1e-10) || (b.lengthSq() < 1e-10)) return;
    a.normalize(); b.normalize();
    if (a.dot(b) > 0.999999) return;

    q1.setFromUnitVectors(a, b);                  // world-space delta
    joint.parent.getWorldQuaternion(q2);          // parent world rotation
    q3.copy(q2).invert().multiply(q1).multiply(q2); // delta expressed in parent space
    joint.quaternion.premultiply(q3);
    joint.updateMatrixWorld(true);
  }

  function solve_arm(upper, lower, hand, target) {
    hand.getWorldQuaternion(q_hand);              // keep the hand's world orientation
    for (let i = 0; i < CFG.iterations; i++) {
      rotate_toward(lower, hand, target);
      rotate_toward(upper, hand, target);
    }
    hand.parent.getWorldQuaternion(q2);
    hand.quaternion.copy(q2.invert().multiply(q_hand));
    hand.updateMatrixWorld(true);
  }

// --- proportion-corrected hand placement ---
// Real wrist positions are expressed in the user's own body frame (x in shoulder widths, y in
// shoulder-line-to-nose heights) and re-applied in the avatar's body frame (shoulders, head).
// Only the sideways and vertical components are corrected; the avatar keeps its own depth.
  function body_frame_real(k) {
    for (const i of [0, 11, 12, 15, 16]) {
      if ((k[i].score != null) && (k[i].score < 0.5)) return null;
    }
    const P = (i)=>new THREE_.Vector3(k[i].x, k[i].y, k[i].z);
    const shL = P(11), shR = P(12), nose = P(0);
    const mid = shL.clone().add(shR).multiplyScalar(0.5);
    const X = shR.clone().sub(shL);
    const sw = X.length();
    if (!(sw > 1e-6)) return null;
    X.normalize();
    const Y = nose.clone().sub(mid);
    Y.addScaledVector(X, -Y.dot(X));
    const th = Y.length();
    if (!(th > 1e-6)) return null;
    Y.normalize();
    return { mid, X, Y, sw, th, wrists: [P(15), P(16)] };
  }

  function body_frame_avatar(model) {
    const b = (n)=>model.getBoneNode(n, false);
    const uL = b('leftUpperArm'), uR = b('rightUpperArm'), head = b('head');
    if (!uL || !uR || !head) return null;
    const shL = uL.getWorldPosition(new THREE_.Vector3());
    const shR = uR.getWorldPosition(new THREE_.Vector3());
    const hd  = head.getWorldPosition(new THREE_.Vector3());
    const mid = shL.clone().add(shR).multiplyScalar(0.5);
    const X = shR.clone().sub(shL);
    const sw = X.length();
    if (!(sw > 1e-6)) return null;
    X.normalize();
    const Y = hd.clone().sub(mid);
    Y.addScaledVector(X, -Y.dot(X));
    const th = Y.length();
    if (!(th > 1e-6)) return null;
    Y.normalize();
    const Z = new THREE_.Vector3().crossVectors(X, Y).normalize();
    return { mid, X, Y, Z, sw, th };
  }

  function place_hands(model, B) {
    if (!S.pose3D || (performance.now() - (S.t_pose||0) > CFG.stale_ms)) { S.place_prev = null; return; }
    const R = body_frame_real(S.pose3D);
    const A = body_frame_avatar(model);
    if (!R || !A) return;

    // real wrists in normalized body coordinates [sideways, up]
    const norm = R.wrists.map(w=>{
      const d = w.clone().sub(R.mid);
      return [d.dot(R.X) / R.sw, d.dot(R.Y) / R.th];
    });

    // current avatar wrists (from direction retargeting)
    const cur = [B.left.hand.getWorldPosition(new THREE_.Vector3()), B.right.hand.getWorldPosition(new THREE_.Vector3())];

    // candidate targets for a given sideways sign (resolves mirroring) and a given assignment
    const target_of = (n, sign, depth_from)=>{
      const depth = depth_from.clone().sub(A.mid).dot(A.Z);
      return A.mid.clone()
        .addScaledVector(A.X, sign * n[0] * A.sw)
        .addScaledVector(A.Y, n[1] * A.th)
        .addScaledVector(A.Z, depth);
    };
    let best = null;
    for (const sign of [1, -1]) {
      for (const swap of [false, true]) {
        const nL = norm[swap ? 1 : 0], nR = norm[swap ? 0 : 1];
        const tL = target_of(nL, sign, cur[0]), tR = target_of(nR, sign, cur[1]);
        const cost = tL.distanceTo(cur[0]) + tR.distanceTo(cur[1]);
        if (!best || cost < best.cost) best = { cost, tL, tR };
      }
    }

    // smooth targets, then blend with the direction-retargeted position
    if (S.place_prev) {
      best.tL.lerpVectors(S.place_prev[0], best.tL, CFG.place_smooth);
      best.tR.lerpVectors(S.place_prev[1], best.tR, CFG.place_smooth);
    }
    S.place_prev = [best.tL.clone(), best.tR.clone()];

    const k = CFG.place_strength;
    solve_arm(B.left.upper,  B.left.lower,  B.left.hand,  cur[0].clone().lerp(best.tL, k));
    solve_arm(B.right.upper, B.right.lower, B.right.hand, cur[1].clone().lerp(best.tR, k));
  }

// --- 2. per-frame correction ---
  window.addEventListener('XRA_after_update_model', function () {
    if (!self.MMD_SA || !MMD_SA.THREEX?.enabled) return;
    const model = MMD_SA.THREEX.get_model(0);
    if (!model?.getBoneNode || !model.mesh) return;
    if (!System._browser.camera?.ML_enabled) { S.weight = 0; S.place_prev = null; return; }

    if (!THREE_) init_math();

    const B = {};
    for (const side of ['left', 'right']) {
      B[side] = {
        upper: model.getBoneNode(side + 'UpperArm', false),
        lower: model.getBoneNode(side + 'LowerArm', false),
        hand:  model.getBoneNode(side + 'Hand', false),
        mid:   model.getBoneNode(side + 'MiddleProximal', false),
      };
      if (!B[side].upper || !B[side].lower || !B[side].hand) return;
    }

    model.mesh.updateMatrixWorld(true);

// a. proportion-corrected placement (always, when both wrists are tracked)
    place_hands(model, B);

// b. contact correction (only when the real hands are close)
    const real = real_gap_palm_units();
    const w_target = (real) ? 1 - smoothstep(CFG.near, CFG.far, real.wrist_gap) : 0;
    S.weight += (w_target - S.weight) * CFG.blend;
    if (S.weight < 0.01 || !real) return;

    const pL = B.left.hand.getWorldPosition(new THREE_.Vector3());
    const pR = B.right.hand.getWorldPosition(new THREE_.Vector3());

    const palm_of = (b)=>(b.mid) ? b.hand.getWorldPosition(v1).distanceTo(b.mid.getWorldPosition(v2)) : 0;
    let palm_av = (palm_of(B.left) + palm_of(B.right)) / 2;
    if (!(palm_av > 1e-4)) palm_av = pL.distanceTo(pR) * 0.1 || 0.08;

    const d_av = pL.distanceTo(pR);
    const d_target = real.wrist_gap * palm_av;
    let move = (d_av - d_target) / 2 * S.weight;   // per side; >0 pulls together, <0 pushes apart
    const max_move = CFG.max_move * palm_av;
    move = Math.max(Math.min(move, max_move), -max_move);
    if (Math.abs(move) < palm_av * 0.01) return;

    const dir = new THREE_.Vector3().subVectors(pR, pL).normalize();
    const tL = pL.clone().addScaledVector(dir,  move);
    const tR = pR.clone().addScaledVector(dir, -move);

    solve_arm(B.left.upper,  B.left.lower,  B.left.hand,  tL);
    solve_arm(B.right.upper, B.right.lower, B.right.hand, tR);
  });

  self.XRA_hand_contact = { config: CFG, state: S };
})();

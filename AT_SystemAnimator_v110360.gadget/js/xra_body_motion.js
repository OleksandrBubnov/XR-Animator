// XRA-lite: body motion (lean + torso movement), always on, no setup
//
// From the pose tracking already running (no extra models):
//  - torso: shoulder width in the image (bigger = closer) and shoulder midpoint (sideways / up-down)
//  - head:  eye distance in the image (bigger = closer) and eye midpoint
// The user's rest position is learned automatically (fast for the first seconds, then very slowly).
//
// Applied to the avatar right before drawing (event "XRA_after_update_model"), before hand placement:
//  - torso movement -> hips translation, in screen directions (render camera), scaled to avatar size
//  - head moving forward more than the torso -> forward lean through spine + chest
//
// Bones XR Animator doesn't rewrite every frame (e.g. hips) would accumulate edits, so every edit is
// recorded and undone at the start of the next frame if the bone still holds our value.
//
// Live tuning: window.XRA_body_motion.config (Ctrl+Shift+I console).

(function () {
  const CFG = {
    enabled: true,
    hfov_deg: 70,          // webcam horizontal field of view [assumed; tune if forward motion is too weak/strong]
    gain_forward: 1.0,     // torso toward/away from camera
    gain_side: 1.0,        // torso sideways
    gain_vertical: 0.6,    // torso up/down (sitting up straighter, slouching)
    gain_lean: 0.8,        // forward lean from head-vs-torso
    deadzone: 0.02,        // ignore movement smaller than this (shoulder widths) to keep the avatar calm at rest
    max_move: 0.8,         // safety: max torso translation, in avatar shoulder widths
    max_lean_deg: 25,      // safety: max forward/back lean
    smooth: 0.35,          // 0..1 per frame, output smoothing (higher = snappier)
    rest_fast_s: 3,        // rest position: fast learning for the first seconds
    rest_slow_s: 45,       // then adapts with this time constant (seconds)
    stale_ms: 250,
    min_score: 0.5,
  };

  const S = {
    rest: null, t_start: 0,
    out: { side: 0, up: 0, fwd: 0, lean: 0 },
    edits: [],
  };

// ---------------------------------------------------------------------------------------------------
  let T, v1, v2, v3, q1, q2, q3;
  function init_math() {
    T = MMD_SA.THREEX.THREE;
    v1 = new T.Vector3(); v2 = new T.Vector3(); v3 = new T.Vector3();
    q1 = new T.Quaternion(); q2 = new T.Quaternion(); q3 = new T.Quaternion();
  }

  const lerp = (a, b, t)=>a + (b - a) * t;
  const clamp = (x, a, b)=>Math.min(Math.max(x, a), b);
  const soft_deadzone = (x, dz)=>(Math.abs(x) <= dz) ? 0 : x - Math.sign(x) * dz;

// --- edits that are undone next frame unless XR Animator rewrote the bone in between ---
  function revert_stale_edits() {
    for (const e of S.edits) {
      if (e.obj[e.prop].equals(e.after)) e.obj[e.prop].copy(e.before);
    }
    S.edits.length = 0;
  }
  function edit(obj, prop, fn) {
    const before = obj[prop].clone();
    fn(obj[prop]);
    S.edits.push({ obj, prop, before, after: obj[prop].clone() });
    obj.updateMatrixWorld(true);
  }

  function rotate_world(bone, axis, angle) {
    if (!bone || Math.abs(angle) < 1e-5) return;
    q1.setFromAxisAngle(axis, angle);
    bone.parent.getWorldQuaternion(q2);
    q3.copy(q2).invert().multiply(q1).multiply(q2);
    edit(bone, 'quaternion', q=>q.premultiply(q3).normalize());
  }

  function translate_world(bone, delta) {
    if (!bone || (delta.lengthSq() < 1e-12)) return;
    bone.getWorldPosition(v1).add(delta);
    const local = bone.parent.worldToLocal(v1);
    edit(bone, 'position', p=>p.copy(local));
  }

// ---------------------------------------------------------------------------------------------------
// measurement from the pose keypoints (image pixels; BlazePose 2/5 eyes, 11/12 shoulders)
  function measure(posenet) {
    const k = posenet?.keypoints;
    if (!k || (k.length < 33)) return null;
    for (const i of [2, 5, 11, 12]) {
      if (!k[i]?.position || ((k[i].score != null) && (k[i].score < CFG.min_score))) return null;
    }
    const p = (i)=>k[i].position;
    const d2 = (a, b)=>Math.hypot(a.x - b.x, a.y - b.y);
    return {
      sw: d2(p(11), p(12)),                                   // shoulder width, px
      sx: (p(11).x + p(12).x) / 2, sy: (p(11).y + p(12).y) / 2, // shoulder midpoint, px
      ew: d2(p(2), p(5)),                                     // eye distance, px
      ex: (p(2).x + p(5).x) / 2, ey: (p(2).y + p(5).y) / 2,   // eye midpoint, px
    };
  }

  function update_rest(m, now) {
    if (!S.rest) { S.rest = Object.assign({}, m); S.t_start = now; return; }
    const fast = (now - S.t_start) < CFG.rest_fast_s * 1000;
    const a = fast ? 0.15 : 1 / (CFG.rest_slow_s * 60);
    for (const key in m) S.rest[key] = lerp(S.rest[key], m[key], a);
  }

// ---------------------------------------------------------------------------------------------------
  window.addEventListener('XRA_after_update_model', function () {
    if (!self.MMD_SA || !MMD_SA.THREEX?.enabled) return;
    if (!T) init_math();

    revert_stale_edits();

    const camera = MMD_SA.THREEX.data?.camera;
    const model = MMD_SA.THREEX.get_model(0);
    const hc = self.XRA_hand_contact?.state;
    const active = CFG.enabled && camera && model?.getBoneNode && model.mesh &&
      System._browser.camera?.ML_enabled && System._browser.camera?.poseNet?.enabled &&
      hc?.posenet && (performance.now() - hc.t_posenet < CFG.stale_ms);

    const m = active && measure(hc.posenet);
    const now = performance.now();

    let tgt = { side: 0, up: 0, fwd: 0, lean: 0 };
    if (m) {
      update_rest(m, now);
      const r = S.rest;

// focal length in px from the webcam image width and the assumed field of view
      const vw = System._browser.camera.video?.videoWidth || 1280;
      const f = (vw / 2) / Math.tan(CFG.hfov_deg * Math.PI / 360);

// distances in shoulder widths / eye distances (pinhole: Z = f * size / px)
      const z_torso = f / m.sw, z_torso_rest = f / r.sw;          // shoulder widths
      const z_head  = f / m.ew, z_head_rest  = f / r.ew;          // eye distances
      const fwd_torso = z_torso_rest - z_torso;                   // + = toward camera (shoulder widths)
      const fwd_head_sw = (z_head_rest - z_head) * (r.ew / r.sw); // head forward, converted to shoulder widths

// sideways / vertical in shoulder widths (screen directions; the image is mirrored like the OBS view)
      const side = (m.sx - r.sx) / m.sw;
      const up = -(m.sy - r.sy) / m.sw;

      tgt.side = soft_deadzone(side, CFG.deadzone) * CFG.gain_side;
      tgt.up   = soft_deadzone(up,   CFG.deadzone) * CFG.gain_vertical;
      tgt.fwd  = soft_deadzone(fwd_torso, CFG.deadzone) * CFG.gain_forward;
      tgt.lean = soft_deadzone(fwd_head_sw - fwd_torso, CFG.deadzone);   // head ahead of torso
    }

// smooth (decays back to rest when tracking is lost)
    for (const key in S.out) S.out[key] = lerp(S.out[key], tgt[key], CFG.smooth);
    if (!active) return;

    const bone = (n)=>model.getBoneNode(n);
    const hips = bone('hips'), spine = bone('spine'), chest = bone('chest') || bone('upperChest');
    const uL = bone('leftUpperArm'), uR = bone('rightUpperArm'), head = bone('head');
    if (!hips || !spine || !uL || !uR || !head) return;

    model.mesh.updateMatrixWorld(true);
    camera.updateMatrixWorld();

// avatar size and screen directions
    const av_sw = uL.getWorldPosition(v1).distanceTo(uR.getWorldPosition(v2));
    if (!(av_sw > 1e-4)) return;
    const e = camera.matrixWorld.elements;
    const right = new T.Vector3(e[0], e[1], e[2]).normalize();
    const upv   = new T.Vector3(e[4], e[5], e[6]).normalize();
    const back  = new T.Vector3(e[8], e[9], e[10]).normalize();   // from scene toward the viewer

// 1. torso movement -> hips translation
    const o = S.out;
    const move = new T.Vector3()
      .addScaledVector(right, o.side * av_sw)
      .addScaledVector(upv,   o.up   * av_sw)
      .addScaledVector(back,  o.fwd  * av_sw);
    if (move.length() > CFG.max_move * av_sw) move.setLength(CFG.max_move * av_sw);
    translate_world(hips, move);

// 2. forward lean: tilt spine + chest so the head moves toward the viewer by the head-vs-torso offset
    const torso_len = spine.getWorldPosition(v1).distanceTo(head.getWorldPosition(v2));
    if (torso_len > 1e-4) {
      let angle = Math.atan2(o.lean * av_sw, torso_len) * CFG.gain_lean;
      const max = CFG.max_lean_deg * Math.PI / 180;
      angle = clamp(angle, -max, max);
      const axis = v3.crossVectors(upv, back).normalize();   // rotating "up" toward "back" by +angle
      rotate_world(spine, axis, angle * 0.5);
      rotate_world(chest, axis, angle * 0.5);
    }

    const humanoid = model.model?.humanoid;
    if (humanoid?.autoUpdateHumanBones && (typeof humanoid.update == 'function')) humanoid.update();
  });

  self.XRA_body_motion = { config: CFG, state: S };
})();

// Renders the mascot model into one small transparent canvas that travels with the character.
// Loaded on demand (it pulls in Three.js), after the page itself is ready.
import { WebGLRenderer, Scene, PerspectiveCamera, HemisphereLight, DirectionalLight, AmbientLight, PMREMGenerator, Vector3 } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildMascot } from './model.js';
import { K, FOOT_Y } from './motion.js';

export const VIEW = 4.6;                      // body units visible across the (square) canvas

export function createStage(canvas) {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  const scene = new Scene();
  const pm = new PMREMGenerator(renderer);
  const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  pm.dispose();

  // a slightly raised, long-lens camera: close to an orthographic view, so screen positions stay true,
  // with enough perspective for real turns
  const fov = 22, dist = (VIEW / 2) / Math.tan((fov / 2) * Math.PI / 180), elev = 0.09;
  const camera = new PerspectiveCamera(fov, 1, 0.5, 60);
  camera.position.set(0, Math.sin(elev) * dist, Math.cos(elev) * dist);
  camera.lookAt(0, 0, 0);

  // light: cool key from the upper right, violet / pink from the left and below, a cyan rim from behind
  scene.add(new AmbientLight('#4f5cff', 0.25));
  scene.add(new HemisphereLight('#8fdcff', '#5a2bc4', 0.55));
  const key = new DirectionalLight('#e6f4ff', 1.25); key.position.set(2.5, 3.2, 4); scene.add(key);
  const left = new DirectionalLight('#ff5fd8', 1.1); left.position.set(-3.5, 0.4, 1.2); scene.add(left);
  const rimL = new DirectionalLight('#45dcff', 1.2); rimL.position.set(2.5, 1.5, -3); scene.add(rimL);

  const m = buildMascot();
  scene.add(m.root);

  function resize(px, dpr) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(px, px, false);
  }

  // pose → joints (sx / sy, the whole character's screen offset, is applied by moving the canvas)
  function apply(P, yaw, roll) {
    m.spin.rotation.z = roll + P[K.sr];
    m.yaw.rotation.y = yaw;
    m.body.position.set(P[K.bx], P[K.by], P[K.bz]);
    m.body.rotation.set(P[K.pitch], P[K.twist], P[K.roll]);
    const sq = P[K.sq];
    m.torso.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
    m.torso.position.y = -0.93 * sq;
    m.armL.rotation.set(P[K.aLx], P[K.aLy], P[K.aLz]);
    m.armR.rotation.set(P[K.aRx], P[K.aRy], P[K.aRz]);
    reach(m.armL); reach(m.armR);
    m.legL.hip.rotation.set(P[K.lLx], 0, P[K.lLz]);
    m.legR.hip.rotation.set(P[K.lRx], 0, P[K.lRz]);
    m.legL.foot.position.y = FOOT_Y + P[K.fLy]; m.legL.foot.rotation.x = P[K.fLp];
    m.legR.foot.position.y = FOOT_Y + P[K.fRy]; m.legR.foot.rotation.x = P[K.fRp];
    m.gemPivot.rotation.z = P[K.gemT];
  }

  // the arms are floating crystal lumps: the higher an arm points, the further it reaches from its
  // shoulder, so raised arms (cheering, climbing, hanging) clear the round body
  const down = new Vector3();
  function reach(sh) {
    down.set(0, -1, 0).applyEuler(sh.rotation);
    const t = Math.max(0, Math.min(1, (down.y - 0.3) / 0.62));
    sh.userData.mesh.position.y = -(0.3 + 0.62 * t * t * (3 - 2 * t));
  }

  // where should the eye sit to look at a point? (dx, dy: body units from the body center, screen axes,
  // y up; the point is taken a little in front of the screen, where the viewer is)
  const v = new Vector3();
  function lookDir(dx, dy, depth = 4) {
    m.root.updateMatrixWorld(true);
    v.set(dx, dy, depth);
    m.speaker.worldToLocal(v);
    v.normalize();
    let x = v.x * 1.9, y = v.y * 1.9;
    if (v.z < 0.15) { const l = Math.hypot(x, y) || 1; x /= l; y /= l; }   // behind it: as far as it can look
    return [x, y];
  }

  let last = 0;
  function render(dt) {
    m.update(dt);
    renderer.render(scene, camera);
    last = performance.now();
  }

  function dispose() {
    m.dispose(); env.dispose(); renderer.dispose();
  }

  return { m, resize, apply, lookDir, render, dispose, get lastRender() { return last; } };
}

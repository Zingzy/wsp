// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";

const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }`;

// Ordered dither of a photo to two colors, one 8x8 Bayer cell per canvas pixel; CSS scales each pixel up to a cell.
const FRAG = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_texRes;
uniform float u_time;
uniform vec3 u_fg;
uniform vec3 u_bg;
uniform vec2 u_fade;
uniform float u_hole;

float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
float bayer4(vec2 a) { return bayer2(.5 * a) * .25 + bayer2(a); }
float bayer8(vec2 a) { return bayer4(.5 * a) * .25 + bayer2(a); }
float mirror(float x) { return abs(fract(x * .5) * 2. - 1.); }

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 uv = (cell + .5) / u_res;
  float ra = u_res.x / u_res.y;
  float ta = u_texRes.x / u_texRes.y;
  vec2 s = ra > ta ? vec2(1., ta / ra) : vec2(ra / ta, 1.);
  vec2 tuv = (uv - .5) * s * 0.86 + .5;
  tuv.y = 1. - tuv.y;
  tuv.x += u_time * 0.004;
  tuv.y += 0.006 * sin(u_time * 0.2 + tuv.x * 6.283);
  tuv = vec2(mirror(tuv.x), mirror(tuv.y));
  vec3 c = texture2D(u_tex, tuv).rgb;
  float l = dot(c, vec3(.299, .587, .114));
  l = smoothstep(0.7, 1.0, l) * 0.72;
  l *= smoothstep(0.0, max(u_fade.x, 0.001), uv.y);
  l *= smoothstep(1.0, 1.0 - u_fade.y, uv.y);
  float hx = 1. - smoothstep(0.22, 0.48, abs(uv.x - .5));
  float hy = 1. - smoothstep(0.3, 0.52, abs(uv.y - .46));
  l *= 1. - u_hole * hx * hy;
  // The matrix holds a zero, so a bare step lights one cell in 64 wherever the picture is not pure black.
  float on = step(bayer8(cell) + 1. / 64., l);
  gl_FragColor = vec4(mix(u_bg, u_fg, on), 1.);
}
`;

type Rgb = readonly [number, number, number];

type DitherProps = {
  src: string;
  className?: string;
  /** How far the picture dissolves into the page from the bottom edge and from the top edge, both 0 to 1; 0 is a hard edge. */
  fade?: readonly [number, number];
  /** How much to clear the middle block, where the type sits, 0 to 1. */
  hole?: number;
  fg?: Rgb;
  bg?: Rgb;
};

const FG: Rgb = [0.6, 0.68, 0.8];
const BG: Rgb = [11 / 255, 12 / 255, 16 / 255];

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

export function Dither({ src, className, fade = [0, 0.15], hole = 0, fg = FG, bg = BG }: DitherProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) return;
    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vert || !frag || !program) return;
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const a = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform3f(u("u_fg"), fg[0], fg[1], fg[2]);
    gl.uniform3f(u("u_bg"), bg[0], bg[1], bg[2]);
    gl.uniform2f(u("u_fade"), fade[0], fade[1]);
    gl.uniform1f(u("u_hole"), hole);
    const uRes = u("u_res");
    const uTime = u("u_time");
    const uTexRes = u("u_texRes");

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let loaded = false;
    let visible = true;
    let frame = 0;
    let lost = false;
    const start = performance.now();

    // One canvas pixel per 3 CSS px cell, sized so the upscale is a whole number of device pixels.
    const host = canvas.parentElement ?? canvas;
    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cell = Math.max(2, Math.round(3 * dpr));
      const w = Math.ceil((host.clientWidth * dpr) / cell);
      const h = Math.ceil((host.clientHeight * dpr) / cell);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${(w * cell) / dpr}px`;
        canvas.style.height = `${(h * cell) / dpr}px`;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
    };

    const draw = () => {
      if (!loaded || lost) return;
      size();
      gl.uniform1f(uTime, (performance.now() - start) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const loop = () => {
      frame = 0;
      if (!visible || document.hidden || still) return;
      draw();
      frame = requestAnimationFrame(loop);
    };
    const wake = () => {
      if (frame === 0) loop();
    };

    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      gl.uniform2f(uTexRes, image.naturalWidth, image.naturalHeight);
      loaded = true;
      canvas.dataset.ready = "true";
      draw();
      wake();
    };
    image.src = src;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      wake();
    });
    observer.observe(canvas);
    const onVisibility = () => wake();
    document.addEventListener("visibilitychange", onVisibility);
    const onResize = () => (still ? draw() : wake());
    window.addEventListener("resize", onResize);
    const onLost = (event: Event) => {
      event.preventDefault();
      lost = true;
    };
    canvas.addEventListener("webglcontextlost", onLost);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("webglcontextlost", onLost);
      image.onload = null;
    };
  }, [src, fade, hole, fg, bg]);

  return <canvas ref={ref} aria-hidden="true" className={className} style={{ imageRendering: "pixelated" }} />;
}

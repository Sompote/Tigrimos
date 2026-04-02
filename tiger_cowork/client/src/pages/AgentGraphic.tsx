import { useState, useEffect, useRef, useCallback } from "react";

interface AgentGraphicProps {
  agentTools: Record<string, string[]>;
  activeAgents: string[];
  doneAgents: string[];
  status: string;
}

// ─── Minecraft character templates ───
// Each character is defined as an 10-wide x 20-tall pixel grid
// using a palette key per pixel. "_" = transparent.
// Layout: rows 0-7 = head (8px centered in cols 1-8), rows 8-15 = body+arms, rows 16-19 = legs

interface CharTemplate {
  name: string;
  palette: Record<string, string>;
  pixels: string[]; // 20 rows, each 10 chars
}

const CHARACTERS: CharTemplate[] = [
  { // Steve
    name: "Steve",
    palette: { h: "#3b2210", s: "#b58d6a", S: "#8c6a4f", w: "#ffffff", p: "#2b1f7a", m: "#694433", t: "#00a8a8", T: "#008383", d: "#2b2b7a", D: "#1e1e5a", g: "#575757" },
    pixels: [
      "_hhhhhhhh_",
      "_hhhhhhhh_",
      "_hssssshh_",
      "_ssssssss_",
      "_swpsspws_",
      "_ssssssss_",
      "_ssmmmmss_",
      "_ssssssss_",
      "tTttttttTt",
      "tTttttttTt",
      "tTTTTTTTTt",
      "sTttttttTs",
      "sTttttttTs",
      "sTttttttTs",
      "_sttttttts_",
      "__dddddd__",
      "_dddDDddd_",
      "_dddDDddd_",
      "_ddd__ddd_",
      "_ggg__ggg_",
    ],
  },
  { // Alex
    name: "Alex",
    palette: { h: "#c47428", H: "#6e3f14", s: "#b58d6a", S: "#8c6a4f", w: "#ffffff", p: "#3a7a27", m: "#694433", t: "#3c7220", T: "#5d9833", d: "#5c3a1e", D: "#3d2510", g: "#575757" },
    pixels: [
      "_hHhhhHhh_",
      "_hhhhhhhh_",
      "_hsssssHh_",
      "_ssssssss_",
      "_swpsspws_",
      "_ssssssss_",
      "_ssmmmmss_",
      "_hssssshh_",
      "sTTtttTTTs",
      "sTTtttTTTs",
      "sTTTTTTTTs",
      "sTTtttTTs_",
      "_TtttttT__",
      "_TtttttT__",
      "__tttttt__",
      "__dddddd__",
      "_dddDDddd_",
      "_dddDDddd_",
      "_ddd__ddd_",
      "_ggg__ggg_",
    ],
  },
  { // Zombie
    name: "Zombie",
    palette: { h: "#3c6620", s: "#5a8832", S: "#486e28", e: "#0c0c0c", m: "#2a4c18", t: "#008383", T: "#006666", d: "#2b2b6e", D: "#1e1e5a", g: "#474747" },
    pixels: [
      "_hhhhhhhh_",
      "_hhhhhhhh_",
      "_hssssshh_",
      "_ssssssss_",
      "_seeSseeS_",
      "_ssssssss_",
      "_sSmmmmsS_",
      "_ssssssss_",
      "sTttTtttTs",
      "sTttTtttTs",
      "sTTTTTTTTs",
      "sTttTtttTs",
      "sTt_ttttTs",
      "sT__ttttTs",
      "__tttttt__",
      "__dddddd__",
      "_dddDDddd_",
      "_dddDDddd_",
      "_ddd__ddd_",
      "_ggg__ggg_",
    ],
  },
  { // Skeleton
    name: "Skeleton",
    palette: { b: "#c8c8c8", B: "#d4d4d4", d: "#a0a0a0", e: "#1a1a1a", m: "#3a3a3a", g: "#888888" },
    pixels: [
      "_bbbbbbbb_",
      "_bBbBBbBb_",
      "_bbbbbbbb_",
      "_bBbbbbBb_",
      "_beebbeeb_",
      "_bbbeebbB_",
      "_bmmmmmBb_",
      "_bBbBBbBb_",
      "__dbbBbd__",
      "__dbbBbd__",
      "__dbbbbd__",
      "__dbbBbd__",
      "__dbbbbd__",
      "__dbbBbd__",
      "__dbbbbd__",
      "__dBddBd__",
      "__db__bd__",
      "__db__bd__",
      "__db__bd__",
      "__dg__gd__",
    ],
  },
  { // Creeper
    name: "Creeper",
    palette: { l: "#5da03a", m: "#4a8c2e", d: "#3a7222", e: "#0c0c0c", D: "#2a5c18" },
    pixels: [
      "_mlmllmml_",
      "_lmmlmmlm_",
      "_lleellel_",
      "_lleellel_",
      "_llleelll_",
      "_leeeeeml_",
      "_lelllelm_",
      "_mlmlmldm_",
      "__mllllm__",
      "__mllllm__",
      "__mlmmld__",
      "__mllllm__",
      "__mllllm__",
      "__mlmmld__",
      "__mllllm__",
      "_mmm_mmm__",
      "_mDm_mDm__",
      "_mDm_mDm__",
      "_mmm_mmm__",
      "_DDm_mDD__",
    ],
  },
  { // Enderman
    name: "Enderman",
    palette: { b: "#161616", B: "#1a1a1a", p: "#e079fa", P: "#ff7eff" },
    pixels: [
      "_bbBbbBbb_",
      "_bBbbbbBb_",
      "_bbbbbbbb_",
      "_bbbbbbbb_",
      "_bppbbppb_",
      "_bbbbbbbb_",
      "_bbbbbbbb_",
      "_bBbbbbBb_",
      "BbbbbbbbBb",
      "Bbb_bb_bBb",
      "_bb_bb_bb_",
      "_bb_bb_bb_",
      "_bbbbbbbb_",
      "_bb_bb_bb_",
      "__b_bb_b__",
      "__bbbbbb__",
      "__b_bb_b__",
      "__b___b___",
      "__b___b___",
      "__b___b___",
    ],
  },
  { // Villager
    name: "Villager",
    palette: { s: "#b58d6a", S: "#8c6a4f", n: "#7a5a40", e: "#2b6e2b", b: "#4a3a20", r: "#7a5c3a", R: "#5c4028", g: "#4a3a20" },
    pixels: [
      "_ssssssss_",
      "_ssssssss_",
      "_sbbbsbbs_",
      "_seessees_",
      "_sssnnsss_",
      "_sssnnsss_",
      "_ssssssss_",
      "_ssssssss_",
      "rRrrrrrrRr",
      "rRrrrrrrRr",
      "rRRRRRRRRr",
      "SRrrrrrrRS",
      "SRrrrrrrRS",
      "SRrrrrrrRS",
      "__rrrrrr__",
      "__rrRRrr__",
      "__rr__rr__",
      "__rr__rr__",
      "__rr__rr__",
      "__gg__gg__",
    ],
  },
  { // Witch
    name: "Witch",
    palette: { p: "#3a1d5c", P: "#4a2874", g: "#2ca82c", s: "#b58d6a", S: "#8c6a4f", e: "#7a2b7a", n: "#8c6a4f", w: "#5a8832", r: "#4a2874", R: "#36205a" },
    pixels: [
      "____pp____",
      "___pppp___",
      "__pppppp__",
      "_pgggggp__",
      "_ssssssss_",
      "_seesseep_",
      "_sssnnsss_",
      "_ssswssss_",
      "rRrrrrrrRr",
      "rRrPPPrrRr",
      "rRRPPPRRRr",
      "sRrPPPrrRs",
      "sRrrrrrrRs",
      "sRrrrrrrRs",
      "__rrrrrr__",
      "__rrRRrr__",
      "__rr__rr__",
      "__rr__rr__",
      "__rr__rr__",
      "__RR__RR__",
    ],
  },
  { // Pillager
    name: "Pillager",
    palette: { h: "#2a2a2a", s: "#7a8a7a", S: "#5c6c5c", e: "#1a1a1a", b: "#3a3a3a", t: "#3a3a4a", T: "#2a2a3a", l: "#6a5a3a", g: "#4a3a20" },
    pixels: [
      "_hhhhhhhh_",
      "_hhhhhhhh_",
      "_hssssssh_",
      "_sbbbsbbs_",
      "_seeSseeb_",
      "_ssssssss_",
      "_sSSSSSsS_",
      "_ssssssss_",
      "tTttttttTt",
      "tTttllttTt",
      "tTTlllTTTt",
      "sTttllttTs",
      "sTttttttTs",
      "sTttttttTs",
      "__tttttt__",
      "__ttTTtt__",
      "__tt__tt__",
      "__tt__tt__",
      "__tt__tt__",
      "__gg__gg__",
    ],
  },
  { // Blaze
    name: "Blaze",
    palette: { y: "#e8b830", Y: "#cc8820", o: "#a86818", e: "#f0e840", r: "#e8c830", k: "#4a4a4a" },
    pixels: [
      "_yYyyyYyy_",
      "_yYyyyyYy_",
      "_yyyyyyYy_",
      "_yyyyyyyy_",
      "_yeeyYeey_",
      "_yyyyyyyy_",
      "_yoYYYoyy_",
      "_yYyyyyYy_",
      "r_yYYYy_r_",
      "r__yyyy__r",
      "r__yYYy__r",
      "___yyyy___",
      "r__yYYy__r",
      "r________r",
      "____kk____",
      "___kkkk___",
      "____kk____",
      "___kkkk___",
      "____kk____",
      "__________",
    ],
  },
  { // Wither Skeleton
    name: "Wither Skel",
    palette: { b: "#3a3a3a", B: "#4a4a4a", d: "#2a2a2a", e: "#1a1a1a", g: "#333333" },
    pixels: [
      "_bbBbbBbb_",
      "_bBbBBbBb_",
      "_bbbbbbbb_",
      "_bBbbbbBb_",
      "_beeBbeeb_",
      "_bbbeebbB_",
      "_bdddddBb_",
      "_bBbBBbBb_",
      "__dbbBbd__",
      "__dbbBbd__",
      "__dbbbbd__",
      "__dbbBbd__",
      "__dbbbbd__",
      "__dbbBbd__",
      "__dbbbbd__",
      "__dBddBd__",
      "__db__bd__",
      "__db__bd__",
      "__db__bd__",
      "__dg__gd__",
    ],
  },
  { // Iron Golem
    name: "Iron Golem",
    palette: { s: "#c4b8a8", S: "#a89888", d: "#8c7c6c", e: "#7a2020", v: "#6c8c3c", g: "#575757" },
    pixels: [
      "_ssssssss_",
      "_sSsSSsSs_",
      "_ssssssss_",
      "_ssssssss_",
      "_seessees_",
      "_ssSddSss_",
      "_ssssssss_",
      "_sSsSSsSs_",
      "dSssssssSD",
      "dSssvsssSD",
      "dSSSvSSSSD",
      "dSssssssSD",
      "dSssssssSD",
      "dSssssssSD",
      "dSssssssSD",
      "__sSddSs__",
      "__sd__ds__",
      "__sd__ds__",
      "__sd__ds__",
      "__gg__gg__",
    ],
  },
];

const NUM_CHARS = CHARACTERS.length;

function agentHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function getCharForAgent(name: string): CharTemplate {
  return CHARACTERS[agentHash(name) % NUM_CHARS];
}

// ─── Drawing ───

const S = 3; // pixel scale per block
const CHAR_PX_W = 10 * S; // 30px
const CHAR_PX_H = 20 * S; // 60px
const CANVAS_H = 280;
const GROUND_H = 14;
const NAME_H = 14;
const Y_MIN = 75;
const Y_MAX = CANVAS_H - GROUND_H - NAME_H - CHAR_PX_H;

function drawChar(ctx: CanvasRenderingContext2D, x: number, y: number, tmpl: CharTemplate, frame: number, facing: "left" | "right" | "front") {
  const { palette, pixels } = tmpl;
  const mirror = facing === "left";

  for (let row = 0; row < pixels.length; row++) {
    const line = pixels[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === "_" || ch === " ") continue;
      const color = palette[ch];
      if (!color) continue;
      ctx.fillStyle = color;
      const drawCol = mirror ? (9 - col) : col;
      // Walk animation: shift legs
      let offY = 0;
      if (frame === 1 && row >= 16) {
        // Alternate legs up/down
        const isLeftLeg = col < 5;
        offY = isLeftLeg ? -1 : 1;
      }
      ctx.fillRect(x + drawCol * S, y + (row + offY) * S, S, S);
    }
  }

  // Add arm swing for walk frame
  if (frame === 1) {
    // Slight arm offset already handled by pixel grid, but add hand pixel movement
    const armColor = palette["s"] || palette["t"] || palette["b"] || "#888";
    ctx.fillStyle = armColor;
    if (!mirror) {
      ctx.fillRect(x + 0 * S, y + 10 * S, S, S); // left hand forward
      ctx.fillRect(x + 9 * S, y + 14 * S, S, S); // right hand back
    } else {
      ctx.fillRect(x + 9 * S, y + 10 * S, S, S);
      ctx.fillRect(x + 0 * S, y + 14 * S, S, S);
    }
  }
}

function drawBubble(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string, maxWidth: number, canvasW: number) {
  ctx.font = "11px 'Courier New', monospace";
  const lines: string[] = [];
  const words = text.split(" ");
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxWidth - 16) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 2) { lines.length = 2; lines[1] = lines[1].slice(0, -3) + "..."; }

  const lineH = 14, padX = 8, padY = 5;
  const bw = Math.min(maxWidth, Math.max(...lines.map(l => ctx.measureText(l).width)) + padX * 2);
  const bh = lines.length * lineH + padY * 2;
  let bx = cx - bw / 2;
  if (bx < 4) bx = 4;
  if (bx + bw > canvasW - 4) bx = canvasW - 4 - bw;
  const by = y - bh - 8;

  ctx.fillStyle = "rgba(30, 30, 40, 0.92)";
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, bw, bh, 6);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(30, 30, 40, 0.92)";
  ctx.beginPath();
  ctx.moveTo(cx - 5, by + bh);
  ctx.lineTo(cx, by + bh + 6);
  ctx.lineTo(cx + 5, by + bh);
  ctx.fill();

  ctx.fillStyle = "#e0e0e0";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], bx + padX, by + padY + i * lineH);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Agent state ───

interface AgentState {
  name: string;
  charTemplate: CharTemplate;
  x: number; y: number;
  targetX: number; targetY: number;
  homeX: number; homeY: number;
  frame: number;
  status: "active" | "waiting" | "done";
  lastTool: string;
  facing: "left" | "right" | "front";
  bubbleText: string;
  interacting: boolean;
}

export default function AgentGraphic({ agentTools, activeAgents, doneAgents }: AgentGraphicProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const agentsRef = useRef<Map<string, AgentState>>(new Map());
  const animRef = useRef<number>(0);
  const tickRef = useRef<number>(0);
  const [canvasWidth, setCanvasWidth] = useState(800);
  const prevToolCountsRef = useRef<Record<string, number>>({});

  const initAgents = useCallback(() => {
    const names = Object.keys(agentTools);
    if (names.length === 0) return;

    const cols = Math.min(names.length, Math.max(3, Math.ceil(Math.sqrt(names.length * 2))));
    const rows = Math.ceil(names.length / cols);
    const spacingX = (canvasWidth - 100) / Math.max(cols - 1, 1);
    const spacingY = rows > 1 ? (Y_MAX - Y_MIN) / (rows - 1) : 0;
    const startX = 50;

    const map = agentsRef.current;
    names.forEach((name, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const homeX = startX + col * spacingX;
      const homeY = rows > 1 ? Y_MIN + row * spacingY : (Y_MIN + Y_MAX) / 2;
      const existing = map.get(name);
      if (existing) {
        existing.homeX = homeX;
        existing.homeY = homeY;
        if (!existing.interacting) {
          existing.targetX = homeX;
          existing.targetY = homeY;
        }
      } else {
        map.set(name, {
          name, charTemplate: getCharForAgent(name),
          x: homeX, y: homeY,
          targetX: homeX, targetY: homeY,
          homeX, homeY,
          frame: 0, status: "waiting",
          lastTool: "", facing: "front",
          bubbleText: "Ready",
          interacting: false,
        });
      }
    });
    for (const key of map.keys()) {
      if (!names.includes(key)) map.delete(key);
    }
  }, [agentTools, canvasWidth]);

  useEffect(() => {
    initAgents();
    const map = agentsRef.current;
    const activeSet = new Set(activeAgents);
    const doneSet = new Set(doneAgents);
    const names = Object.keys(agentTools);
    const prevCounts = prevToolCountsRef.current;

    for (const name of names) {
      const agent = map.get(name);
      if (!agent) continue;
      const tools = agentTools[name] || [];
      const prevCount = prevCounts[name] || 0;
      const newTools = tools.slice(prevCount);

      if (activeSet.has(name)) {
        agent.status = "active";
        if (newTools.length > 0) {
          const lastTool = newTools[newTools.length - 1];
          agent.lastTool = lastTool;
          agent.bubbleText = formatToolText(lastTool);
          if (isCommTool(lastTool)) {
            const targetName = pickTargetAgent(name, names, map);
            if (targetName) {
              const target = map.get(targetName);
              if (target) {
                const midX = (agent.homeX + target.homeX) / 2;
                const midY = (agent.homeY + target.homeY) / 2;
                agent.targetX = midX + (agent.homeX < target.homeX ? -20 : 20);
                agent.targetY = midY + (agent.homeY < target.homeY ? -8 : 8);
                agent.interacting = true;
                agent.facing = agent.homeX < target.homeX ? "right" : "left";
                if (target.status === "active") {
                  target.targetX = midX + (target.homeX < agent.homeX ? -20 : 20);
                  target.targetY = midY + (target.homeY < agent.homeY ? -8 : 8);
                  target.interacting = true;
                  target.facing = target.homeX < agent.homeX ? "right" : "left";
                }
              }
            }
          } else {
            agent.targetX = agent.homeX;
            agent.targetY = agent.homeY;
            agent.interacting = false;
          }
        }
      } else if (doneSet.has(name)) {
        agent.status = "done";
        agent.bubbleText = "Done!";
        agent.targetX = agent.homeX;
        agent.targetY = agent.homeY;
        agent.interacting = false;
      } else {
        agent.status = "waiting";
        agent.targetX = agent.homeX;
        agent.targetY = agent.homeY;
        agent.interacting = false;
      }
      prevCounts[name] = tools.length;
    }
    prevToolCountsRef.current = prevCounts;
  }, [agentTools, activeAgents, doneAgents, initAgents]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setCanvasWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = canvasWidth;
    canvas.height = CANVAS_H;
    let running = true;

    const render = () => {
      if (!running) return;
      tickRef.current++;
      const tick = tickRef.current;

      ctx.clearRect(0, 0, canvasWidth, CANVAS_H);

      // Pixelated grass ground
      for (let gx = 0; gx < canvasWidth; gx += 4) {
        const shade = 80 + (gx * 7 % 50);
        ctx.fillStyle = `rgb(${30 + (gx * 3 % 25)}, ${shade}, ${30 + (gx * 11 % 20)})`;
        ctx.fillRect(gx, CANVAS_H - GROUND_H, 4, GROUND_H);
      }
      // Grass top edge
      for (let gx = 0; gx < canvasWidth; gx += 4) {
        if ((gx * 13) % 8 < 5) {
          ctx.fillStyle = `rgb(${50 + (gx * 5 % 30)}, ${120 + (gx * 9 % 40)}, ${40 + (gx * 7 % 25)})`;
          ctx.fillRect(gx, CANVAS_H - GROUND_H - 3 + ((gx * 3) % 4), 3, 4);
        }
      }

      // Sort by Y for depth
      const agents = Array.from(agentsRef.current.values());
      agents.sort((a, b) => a.y - b.y);

      for (const agent of agents) {
        const dx = agent.targetX - agent.x;
        const dy = agent.targetY - agent.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const isMoving = dist > 2;

        if (isMoving) {
          agent.x += dx * 0.06;
          agent.y += dy * 0.06;
          agent.facing = Math.abs(dx) > 2 ? (dx > 0 ? "right" : "left") : agent.facing;
          if (tick % 6 === 0) agent.frame = agent.frame === 0 ? 1 : 0;
        } else {
          agent.x = agent.targetX;
          agent.y = agent.targetY;
          if (agent.status === "active" && tick % 18 === 0) {
            agent.frame = agent.frame === 0 ? 1 : 0;
          } else if (agent.status !== "active") {
            agent.frame = 0;
            if (!agent.interacting) agent.facing = "front";
          }
        }

        const depthFactor = 0.75 + 0.25 * ((agent.y - Y_MIN) / Math.max(Y_MAX - Y_MIN, 1));
        const charCX = agent.x + CHAR_PX_W / 2;

        // Shadow
        ctx.fillStyle = `rgba(0,0,0,${0.1 + 0.08 * depthFactor})`;
        ctx.beginPath();
        ctx.ellipse(charCX, agent.y + CHAR_PX_H * depthFactor + 2, 14 * depthFactor, 3 * depthFactor, 0, 0, Math.PI * 2);
        ctx.fill();

        // Draw character
        const alpha = agent.status === "done" ? 0.4 : agent.status === "waiting" ? 0.55 : 1;
        ctx.globalAlpha = alpha;
        ctx.save();
        ctx.translate(agent.x, agent.y);
        ctx.scale(depthFactor, depthFactor);
        drawChar(ctx, 0, 0, agent.charTemplate, agent.frame, agent.facing);
        ctx.restore();
        ctx.globalAlpha = 1;

        // Active glow
        if (agent.status === "active") {
          const firstColor = Object.values(agent.charTemplate.palette)[0] || "#fff";
          const glow = 0.15 + 0.12 * Math.sin(tick * 0.1);
          ctx.fillStyle = `rgba(${hexToRgb(firstColor)}, ${glow})`;
          ctx.beginPath();
          ctx.ellipse(charCX, agent.y + CHAR_PX_H * depthFactor + 2, 18 * depthFactor, 5 * depthFactor, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (agent.status === "done") {
          ctx.fillStyle = "#10b981";
          ctx.font = `bold ${Math.round(14 * depthFactor)}px sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("\u2713", charCX, agent.y - 2);
        }

        // Name (always under character)
        ctx.font = `bold ${Math.round(9 * depthFactor)}px 'Courier New', monospace`;
        ctx.textAlign = "center";
        ctx.fillStyle = agent.status === "done" ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.85)";
        const nameY = agent.y + CHAR_PX_H * depthFactor + NAME_H;
        ctx.fillText(truncName(agent.name, 16), charCX, nameY);
        // Character type label
        ctx.font = `${Math.round(7 * depthFactor)}px 'Courier New', monospace`;
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.fillText(agent.charTemplate.name, charCX, nameY + 10 * depthFactor);

        // Speech bubble (persistent while active)
        if (agent.status === "active" && agent.bubbleText) {
          drawBubble(ctx, charCX, agent.y - 2, agent.bubbleText, 150, canvasWidth);
        } else if (agent.status === "done") {
          ctx.globalAlpha = 0.5;
          drawBubble(ctx, charCX, agent.y - 2, "Done!", 70, canvasWidth);
          ctx.globalAlpha = 1;
        }

        // Connection lines between interacting agents
        if (agent.interacting && agent.status === "active") {
          for (const other of agents) {
            if (other === agent || !other.interacting || other.status !== "active") continue;
            const ax = charCX, ay = agent.y + CHAR_PX_H * depthFactor / 2;
            const ox = other.x + CHAR_PX_W / 2, oy = other.y + CHAR_PX_H * depthFactor / 2;
            if (Math.sqrt((ox - ax) ** 2 + (oy - ay) ** 2) < 220) {
              ctx.save();
              const fc = Object.values(agent.charTemplate.palette)[0] || "#888";
              ctx.strokeStyle = `rgba(${hexToRgb(fc)}, 0.25)`;
              ctx.lineWidth = 1;
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(ax, ay);
              ctx.lineTo(ox, oy);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.restore();
            }
          }
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [canvasWidth]);

  if (Object.keys(agentTools).length === 0) return null;

  return (
    <div style={{
      background: "linear-gradient(180deg, rgba(10,14,25,0.97) 0%, rgba(20,28,40,0.97) 70%, rgba(30,50,30,0.97) 100%)",
      borderRadius: 8,
      border: "1px solid rgba(255,255,255,0.1)",
      overflow: "hidden",
      marginTop: 8,
    }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: CANVAS_H, display: "block", imageRendering: "pixelated" }} />
    </div>
  );
}

// ─── Helpers ───

function truncName(name: string, max: number): string {
  return name.length > max ? name.slice(0, max - 1) + "\u2026" : name;
}

function hexToRgb(hex: string): string {
  return `${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)}`;
}

const COMM_TOOLS = new Set([
  "send_task", "wait_result", "bb_bid", "bb_propose", "bb_award",
  "proto_tcp_send", "proto_bus_publish", "spawn_subagent",
]);

function isCommTool(tool: string): boolean { return COMM_TOOLS.has(tool); }

function formatToolText(tool: string): string {
  const m: Record<string, string> = {
    web_search: "Searching the web...", fetch_url: "Fetching a page...",
    run_python: "Running Python...", run_react: "Building UI...",
    run_shell: "Running command...", read_file: "Reading file...",
    write_file: "Writing file...", list_files: "Listing files...",
    send_task: "Hey, got a task for you!", wait_result: "Waiting for results...",
    check_agents: "Checking the team...",
    bb_propose: "I'm proposing a task!", bb_bid: "I'll bid on this!",
    bb_award: "Awarding the task!", bb_complete: "Task complete!",
    bb_read: "Checking the board...", bb_log: "Reading audit log...",
    proto_bus_publish: "Broadcasting!", proto_bus_history: "Reading bus...",
    proto_tcp_send: "Sending message!", proto_tcp_read: "Got a message...",
    load_skill: "Loading skill...", list_skills: "Checking skills...",
    clawhub_search: "Searching ClawHub...", clawhub_install: "Installing skill...",
    spawn_subagent: "Spawning helper!",
  };
  return m[tool] || `Using ${tool}...`;
}

function pickTargetAgent(self: string, names: string[], map: Map<string, AgentState>): string | null {
  const active = names.filter(n => n !== self && map.get(n)?.status === "active");
  const pool = active.length > 0 ? active : names.filter(n => n !== self);
  return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
}

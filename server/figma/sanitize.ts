/**
 * [INPUT]: Raw Figma node JSON
 * [OUTPUT]: Bounded SimplifiedFigmaNode and warnings for agent consumption
 * [POS]: A 域 Figma sanitizer —— 压缩原始设计事实，避免把大 JSON 和未知字段塞给 LLM
 * [PROTOCOL]: 只保留白名单字段；未知字段丢弃，不改名兜底、不猜业务语义
 */
import "server-only";
import type {
  RawFigmaNode,
  SimplifiedFigmaEffect,
  SimplifiedFigmaNode,
  SimplifiedFigmaPaint,
} from "./types";

const DEFAULT_MAX_DEPTH = 4;
const MAX_ALLOWED_DEPTH = 8;
const DEFAULT_MAX_NODES = 240;

type SanitizeState = {
  maxDepth: number;
  maxNodes: number;
  seen: number;
  warnings: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function colorToRgba(value: unknown): string | undefined {
  const color = asRecord(value);
  if (!color) return undefined;
  const r = numberValue(color.r);
  const g = numberValue(color.g);
  const b = numberValue(color.b);
  if (r === undefined || g === undefined || b === undefined) return undefined;
  const a = numberValue(color.a) ?? 1;
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

function simplifyPaint(paint: Record<string, unknown>): SimplifiedFigmaPaint | null {
  const type = stringValue(paint.type);
  if (!type) return null;
  const result: SimplifiedFigmaPaint = { type };
  const visible = booleanValue(paint.visible);
  const opacity = numberValue(paint.opacity);
  const imageRef = stringValue(paint.imageRef);
  const color = colorToRgba(paint.color);
  if (visible !== undefined) result.visible = visible;
  if (opacity !== undefined) result.opacity = opacity;
  if (imageRef) result.imageRef = imageRef;
  if (color) result.color = color;
  return result;
}

function simplifyEffect(effect: Record<string, unknown>): SimplifiedFigmaEffect | null {
  const type = stringValue(effect.type);
  if (!type) return null;
  const result: SimplifiedFigmaEffect = { type };
  const visible = booleanValue(effect.visible);
  const radius = numberValue(effect.radius);
  const color = colorToRgba(effect.color);
  const offset = asRecord(effect.offset);
  if (visible !== undefined) result.visible = visible;
  if (radius !== undefined) result.radius = radius;
  if (color) result.color = color;
  if (offset) {
    result.offset = {
      x: numberValue(offset.x),
      y: numberValue(offset.y),
    };
  }
  return result;
}

function boxFrom(node: RawFigmaNode): SimplifiedFigmaNode["box"] {
  const box = asRecord(node.absoluteBoundingBox);
  if (!box) return undefined;
  const width = numberValue(box.width);
  const height = numberValue(box.height);
  if (width === undefined || height === undefined) return undefined;
  return {
    x: numberValue(box.x),
    y: numberValue(box.y),
    w: width,
    h: height,
  };
}

function layoutFrom(node: RawFigmaNode): SimplifiedFigmaNode["layout"] {
  const paddingTop = numberValue(node.paddingTop) ?? 0;
  const paddingRight = numberValue(node.paddingRight) ?? 0;
  const paddingBottom = numberValue(node.paddingBottom) ?? 0;
  const paddingLeft = numberValue(node.paddingLeft) ?? 0;
  const layout = {
    mode: stringValue(node.layoutMode),
    primaryAxisSizingMode: stringValue(node.primaryAxisSizingMode),
    counterAxisSizingMode: stringValue(node.counterAxisSizingMode),
    gap: numberValue(node.itemSpacing),
    padding: [paddingTop, paddingRight, paddingBottom, paddingLeft] as [number, number, number, number],
  };
  return Object.values(layout).some((value) => value !== undefined) ? layout : undefined;
}

function styleRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => {
    return ["string", "number", "boolean"].includes(typeof entry);
  }));
}

function simplifyNode(node: RawFigmaNode, depth: number, state: SanitizeState): SimplifiedFigmaNode | null {
  if (state.seen >= state.maxNodes) {
    if (!state.warnings.includes("Figma node tree was truncated because it exceeded the node count limit.")) {
      state.warnings.push("Figma node tree was truncated because it exceeded the node count limit.");
    }
    return null;
  }

  const visible = booleanValue(node.visible);
  if (visible === false) return null;

  const id = stringValue(node.id);
  const name = stringValue(node.name);
  const type = stringValue(node.type);
  if (!id || !name || !type) return null;

  state.seen += 1;
  const simplified: SimplifiedFigmaNode = { id, name, type };
  if (visible !== undefined) simplified.visible = visible;

  const box = boxFrom(node);
  const layout = layoutFrom(node);
  const fills = asRecordArray(node.fills).map(simplifyPaint).filter((item): item is SimplifiedFigmaPaint => Boolean(item));
  const strokes = asRecordArray(node.strokes).map(simplifyPaint).filter((item): item is SimplifiedFigmaPaint => Boolean(item));
  const effects = asRecordArray(node.effects).map(simplifyEffect).filter((item): item is SimplifiedFigmaEffect => Boolean(item));
  const opacity = numberValue(node.opacity);
  const characters = stringValue(node.characters);

  if (box) simplified.box = box;
  if (layout) simplified.layout = layout;
  if (fills.length) simplified.fills = fills;
  if (strokes.length) simplified.strokes = strokes;
  if (effects.length) simplified.effects = effects;
  if (opacity !== undefined) simplified.opacity = opacity;
  if (characters !== undefined) {
    simplified.text = { characters, style: styleRecord(node.style) };
  }

  const children = asRecordArray(node.children);
  if (children.length && depth < state.maxDepth) {
    const nextChildren = children
      .map((child) => simplifyNode(child, depth + 1, state))
      .filter((child): child is SimplifiedFigmaNode => Boolean(child));
    if (nextChildren.length) simplified.children = nextChildren;
  } else if (children.length && depth >= state.maxDepth) {
    state.warnings.push(`Children under node ${id} were truncated by maxDepth=${state.maxDepth}.`);
  }

  return simplified;
}

export function sanitizeFigmaNode(rawNode: RawFigmaNode, maxDepth?: number): { tree: SimplifiedFigmaNode; warnings: string[] } {
  const depth = Math.min(Math.max(maxDepth ?? DEFAULT_MAX_DEPTH, 1), MAX_ALLOWED_DEPTH);
  const state: SanitizeState = {
    maxDepth: depth,
    maxNodes: DEFAULT_MAX_NODES,
    seen: 0,
    warnings: [],
  };
  const tree = simplifyNode(rawNode, 0, state);
  if (!tree) {
    throw new Error("Figma node did not contain required id, name, and type fields.");
  }
  return { tree, warnings: state.warnings };
}

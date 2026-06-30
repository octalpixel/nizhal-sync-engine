import * as Y from "yjs";

const TEXT_ROOT = "echo:text";
const MAP_ROOT = "echo:map";

export function createCrdtText(initial = ""): Y.Doc {
  const doc = new Y.Doc();
  if (initial.length > 0) {
    doc.getText(TEXT_ROOT).insert(0, initial);
  }
  return doc;
}

export function createCrdtMap(initial: Record<string, unknown> = {}): Y.Doc {
  const doc = new Y.Doc();
  const map = doc.getMap(MAP_ROOT);
  for (const [key, value] of Object.entries(initial)) {
    map.set(key, value);
  }
  return doc;
}

export function getCrdtText(doc: Y.Doc): Y.Text {
  return doc.getText(TEXT_ROOT);
}

export function getCrdtMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(MAP_ROOT);
}

export function encodeCrdtUpdate(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(doc, stateVector);
}

export function applyCrdtUpdate(doc: Y.Doc, update: CrdtUpdateInput): void {
  const bytes = asUint8Array(update);
  if (bytes) Y.applyUpdate(doc, bytes);
}

export function crdtTextContent(doc: Y.Doc): string {
  return doc.getText(TEXT_ROOT).toString();
}

export function crdtMapContent(doc: Y.Doc): Record<string, unknown> {
  return Object.fromEntries(doc.getMap(MAP_ROOT));
}

export function crdtFieldBytes(value: CrdtUpdateInput): Uint8Array | undefined {
  return asUint8Array(value);
}

export type CrdtUpdateInput = Uint8Array | string | number[] | ArrayBuffer | null | undefined;

function asUint8Array(value: CrdtUpdateInput): Uint8Array | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (typeof value === "string") return base64ToBytes(value);
  return undefined;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

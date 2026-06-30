import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as VFS from "wa-sqlite/src/VFS.js";

interface OpenFile {
  name: string;
  path: string;
  flags: number;
  size: number;
  data: Buffer;
}

export class NodeFileVFS extends VFS.Base {
  name = "node-file";
  private readonly rootDir: string;
  private readonly mapIdToFile = new Map<number, OpenFile>();

  constructor(rootDir: string) {
    super();
    mkdirSync(rootDir, { recursive: true });
    this.rootDir = rootDir;
  }

  close(): void {
    for (const fileId of this.mapIdToFile.keys()) {
      this.xClose(fileId);
    }
  }

  xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
    const fileName = name ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
    const filePath = join(this.rootDir, fileName.replaceAll("/", "_"));

    let data: Buffer;
    if (existsSync(filePath)) {
      data = readFileSync(filePath);
    } else if (flags & VFS.SQLITE_OPEN_CREATE) {
      data = Buffer.alloc(0);
    } else {
      return VFS.SQLITE_CANTOPEN;
    }

    this.mapIdToFile.set(fileId, {
      name: fileName,
      path: filePath,
      flags,
      size: data.length,
      data,
    });
    pOutFlags.setInt32(0, flags, true);
    return VFS.SQLITE_OK;
  }

  xClose(fileId: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) {
      return VFS.SQLITE_OK;
    }

    this.mapIdToFile.delete(fileId);
    writeFileSync(file.path, file.data.subarray(0, file.size));
    try {
      const fd = openSync(file.path, "r");
      fsyncSync(fd);
      closeSync(fd);
    } catch {
      // Best-effort durability for the headless test VFS.
    }
    if (file.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) {
      unlinkSync(file.path);
    }
    return VFS.SQLITE_OK;
  }

  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) {
      return VFS.SQLITE_IOERR;
    }

    const bgn = Math.min(iOffset, file.size);
    const end = Math.min(iOffset + pData.byteLength, file.size);
    const nBytes = end - bgn;

    if (nBytes > 0) {
      pData.set(file.data.subarray(bgn, end));
    }

    if (nBytes < pData.byteLength) {
      pData.fill(0, nBytes);
      return VFS.SQLITE_IOERR_SHORT_READ;
    }
    return VFS.SQLITE_OK;
  }

  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) {
      return VFS.SQLITE_IOERR;
    }

    const needed = iOffset + pData.byteLength;
    if (needed > file.data.length) {
      const next = Buffer.alloc(Math.max(needed, file.data.length * 2 || 512));
      file.data.copy(next, 0, 0, file.size);
      file.data = next;
    }

    Buffer.from(pData).copy(file.data, iOffset);
    file.size = Math.max(file.size, needed);
    return VFS.SQLITE_OK;
  }

  xTruncate(fileId: number, iSize: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) {
      return VFS.SQLITE_IOERR;
    }
    file.size = Math.min(file.size, iSize);
    return VFS.SQLITE_OK;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) {
      return VFS.SQLITE_IOERR;
    }
    pSize64.setBigInt64(0, BigInt(file.size), true);
    return VFS.SQLITE_OK;
  }

  xDelete(name: string): number {
    const filePath = join(this.rootDir, name.replaceAll("/", "_"));
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    return VFS.SQLITE_OK;
  }

  xAccess(name: string, _flags: number, pResOut: DataView): number {
    const filePath = join(this.rootDir, name.replaceAll("/", "_"));
    pResOut.setInt32(0, existsSync(filePath) ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }
}

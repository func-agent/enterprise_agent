/**
 * 对象存储（对应 3.1 存储组件 MinIO —— 原始文档 / 审计归档，开启版本化）。
 * 开发用本地文件系统，生产用 MinIO / S3 兼容接口。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface ObjectStore {
  readonly kind: string;
  init(): Promise<void>;
  put(key: string, data: Buffer | string, contentType?: string): Promise<{ key: string; etag: string }>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  /** 归档保留期（天） */
  retentionDays: number;
}

/** 本地文件系统实现 —— POC / 单机开发 */
export class FsObjectStore implements ObjectStore {
  readonly kind = 'fs';

  constructor(private readonly root: string, readonly retentionDays = 90) {}

  async init(): Promise<void> {
    mkdirSync(this.root, { recursive: true });
  }

  private path(key: string): string {
    const full = resolve(this.root, key);
    // 防目录穿越
    if (!full.startsWith(resolve(this.root))) throw new Error(`非法对象 key: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer | string): Promise<{ key: string; etag: string }> {
    const p = this.path(key);
    mkdirSync(join(p, '..'), { recursive: true });
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    writeFileSync(p, buf);
    const etag = createHash('md5').update(buf).digest('hex');
    return { key, etag };
  }

  async get(key: string): Promise<Buffer> {
    return readFileSync(this.path(key));
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.path(key));
  }

  async list(prefix: string): Promise<string[]> {
    const base = resolve(this.root);
    const target = resolve(base, prefix);
    if (!target.startsWith(base) || !existsSync(target)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(relative(base, full));
      }
    };
    walk(target);
    return out;
  }
}

/** MinIO / S3 兼容实现 —— 生产审计归档 */
export class MinioObjectStore implements ObjectStore {
  readonly kind = 'minio';
  // 动态导入，避免无 MinIO 环境下产生硬依赖
  private client: any = null;

  constructor(
    private readonly opts: {
      endPoint: string;
      port: number;
      accessKey: string;
      secretKey: string;
      bucket: string;
      useSSL?: boolean;
    },
    readonly retentionDays = 90,
  ) {}

  async init(): Promise<void> {
    const { Client } = await import('minio');
    this.client = new Client({
      endPoint: this.opts.endPoint,
      port: this.opts.port,
      accessKey: this.opts.accessKey,
      secretKey: this.opts.secretKey,
      useSSL: this.opts.useSSL ?? false,
    });
    const exists = await this.client.bucketExists(this.opts.bucket).catch(() => false);
    if (!exists) {
      await this.client.makeBucket(this.opts.bucket, 'us-east-1');
    }
    // 开启版本化（见 3.1 MinIO 组件说明）
    await this.client.setBucketVersioning(this.opts.bucket, { Status: 'Enabled' }).catch(() => undefined);
  }

  async put(key: string, data: Buffer | string): Promise<{ key: string; etag: string }> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const res = await this.client.putObject(this.opts.bucket, key, buf, buf.length);
    return { key, etag: res.etag ?? '' };
  }

  async get(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.opts.bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.opts.bucket, key);
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const stream = this.client.listObjectsV2(this.opts.bucket, prefix, true);
    for await (const obj of stream) out.push(obj.name);
    return out;
  }
}

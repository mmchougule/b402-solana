import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseArgs, copyTemplate, rewriteProjectName, templatesRoot } from '../index.js';

describe('parseArgs', () => {
  it('accepts a valid lowercase project name', () => {
    expect(parseArgs(['node', 'cli', 'my-agent'])).toEqual({ projectName: 'my-agent' });
  });
  it('rejects uppercase', () => {
    expect(() => parseArgs(['node', 'cli', 'MyAgent'])).toThrow();
  });
  it('rejects empty', () => {
    expect(() => parseArgs(['node', 'cli'])).toThrow();
  });
  it('rejects multiple positionals', () => {
    expect(() => parseArgs(['node', 'cli', 'a', 'b'])).toThrow();
  });
  it('rejects starting with hyphen', () => {
    expect(() => parseArgs(['node', 'cli', '-bad'])).toThrow();
  });
});

describe('copyTemplate + rewriteProjectName', () => {
  it('writes a complete template tree and renames the package', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-b402-agent-'));
    const dest = path.join(tmpRoot, 'demo-out');
    try {
      const r = copyTemplate(templatesRoot(), dest);
      expect(r.filesWritten).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(dest, '.env.example'))).toBe(true);
      expect(fs.existsSync(path.join(dest, '.gitignore'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'src', 'index.ts'))).toBe(true);

      rewriteProjectName(dest, 'my-actual-name');
      const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
      expect(pkg.name).toBe('my-actual-name');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing destination', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-b402-agent-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, 'existing'));
      expect(() => copyTemplate(templatesRoot(), path.join(tmpRoot, 'existing'))).toThrow();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

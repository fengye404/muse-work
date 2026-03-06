import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SkillInfo } from '../../types';

interface ParsedSkillDocument {
  name: string;
  description: string;
  body: string;
}

interface SkillRecord extends SkillInfo {
  body: string;
}

type SkillSource = SkillInfo['source'];

function parseFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: '', body: raw.trim() };
  }

  return {
    frontmatter: match[1] || '',
    body: raw.slice(match[0].length).trim(),
  };
}

function parseYamlScalarValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillDocument(folderName: string, raw: string): ParsedSkillDocument {
  const { frontmatter, body } = parseFrontmatter(raw);
  if (!frontmatter) {
    return {
      name: folderName,
      description: '',
      body,
    };
  }

  const lines = frontmatter.split(/\r?\n/);
  let name = folderName;
  let description = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const nameMatch = line.match(/^name:\s*(.+)\s*$/);
    if (nameMatch) {
      const parsed = parseYamlScalarValue(nameMatch[1] || '');
      if (parsed) name = parsed;
      continue;
    }

    const descMatch = line.match(/^description:\s*(.*)\s*$/);
    if (!descMatch) continue;

    const descRaw = descMatch[1] || '';
    if (descRaw.startsWith('>') || descRaw.startsWith('|')) {
      const collected: string[] = [];
      let cursor = i + 1;
      while (cursor < lines.length) {
        const nextLine = lines[cursor] || '';
        if (!/^\s+/.test(nextLine)) break;
        collected.push(nextLine.trim());
        cursor += 1;
      }
      description = collected.join(' ').trim();
      i = cursor - 1;
      continue;
    }

    description = parseYamlScalarValue(descRaw);
  }

  return {
    name: name || folderName,
    description: description.trim(),
    body,
  };
}

function toSkillSourceOrder(source: SkillSource): number {
  if (source === 'workspace') return 0;
  if (source === 'codex') return 1;
  return 2;
}

export class SkillManager {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  listSkills(): SkillInfo[] {
    return this.scanSkillRecords().map(({ body: _body, ...info }) => info);
  }

  buildSystemPrompt(enabledSkillIds: string[]): string {
    const selected = new Set(enabledSkillIds);
    if (selected.size === 0) return '';

    const records = this.scanSkillRecords().filter((skill) => selected.has(skill.id));
    if (records.length === 0) return '';

    const maxPerSkillChars = 6000;
    const maxTotalChars = 24000;

    const blocks: string[] = [];
    let consumed = 0;

    for (const skill of records) {
      if (consumed >= maxTotalChars) break;

      const trimmedBody = skill.body.trim();
      if (!trimmedBody) continue;

      const slice = trimmedBody.slice(0, maxPerSkillChars);
      const finalBody = consumed + slice.length > maxTotalChars
        ? slice.slice(0, maxTotalChars - consumed)
        : slice;

      if (!finalBody) break;

      blocks.push([
        `## Skill: ${skill.name}`,
        `Source: ${skill.source}`,
        `Path: ${skill.path}`,
        finalBody,
      ].join('\n'));

      consumed += finalBody.length;
    }

    if (blocks.length === 0) return '';

    return [
      '以下是当前会话启用的技能说明。请在回答中遵循这些技能定义的流程与约束。',
      ...blocks,
    ].join('\n\n');
  }

  private scanSkillRecords(): SkillRecord[] {
    const records: SkillRecord[] = [];
    const roots = this.resolveSkillRoots();

    for (const root of roots) {
      if (!fs.existsSync(root.dirPath)) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(root.dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const folderPath = path.join(root.dirPath, entry.name);
        const skillFile = path.join(folderPath, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;

        let raw = '';
        try {
          raw = fs.readFileSync(skillFile, 'utf8');
        } catch {
          continue;
        }

        const parsed = parseSkillDocument(entry.name, raw);
        const id = `${root.source}:${entry.name}`;
        records.push({
          id,
          name: parsed.name || entry.name,
          description: parsed.description,
          source: root.source,
          path: folderPath,
          body: parsed.body,
        });
      }
    }

    records.sort((left, right) => {
      const sourceOrder = toSkillSourceOrder(left.source) - toSkillSourceOrder(right.source);
      if (sourceOrder !== 0) return sourceOrder;
      return left.name.localeCompare(right.name);
    });

    return records;
  }

  private resolveSkillRoots(): Array<{ source: SkillSource; dirPath: string }> {
    const roots: Array<{ source: SkillSource; dirPath: string }> = [
      { source: 'workspace', dirPath: path.join(this.workspaceRoot, '.claude', 'skills') },
      { source: 'home', dirPath: path.join(os.homedir(), '.claude', 'skills') },
    ];

    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome) {
      roots.push({ source: 'codex', dirPath: path.join(codexHome, 'skills') });
    }

    return roots;
  }
}

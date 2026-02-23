/**
 * One-time script to register already-applied skills with the skills engine.
 *
 * Reads each skill's manifest.yaml, checks which files exist in the working tree,
 * computes SHA-256 hashes, and calls recordSkillApplication().
 */

import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

import { computeFileHash, recordSkillApplication, readState } from '../skills-engine/state.js';
import type { SkillManifest } from '../skills-engine/types.js';

const SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');
const ROOT = process.cwd();

// Skills that have actually been applied (files exist in working tree)
const SKILLS_TO_REGISTER = ['add-image-support', 'add-slack'];

for (const skillDirName of SKILLS_TO_REGISTER) {
  const manifestPath = path.join(SKILLS_DIR, skillDirName, 'manifest.yaml');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest;
  const allFiles = [...(manifest.adds || []), ...(manifest.modifies || [])];

  // Verify all files exist
  const missing: string[] = [];
  for (const relPath of allFiles) {
    if (!fs.existsSync(path.join(ROOT, relPath))) {
      missing.push(relPath);
    }
  }

  if (missing.length > 0) {
    console.error(`Skill "${manifest.skill}": missing files: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Compute hashes for all files
  const fileHashes: Record<string, string> = {};
  for (const relPath of allFiles) {
    fileHashes[relPath] = computeFileHash(path.join(ROOT, relPath));
  }

  // Build structured outcomes from manifest
  const structuredOutcomes: Record<string, unknown> = {};
  if (manifest.structured?.npm_dependencies) {
    structuredOutcomes.npm_dependencies = manifest.structured.npm_dependencies;
  }
  if (manifest.structured?.env_additions) {
    structuredOutcomes.env_additions = manifest.structured.env_additions;
  }

  recordSkillApplication(
    manifest.skill,
    manifest.version,
    fileHashes,
    Object.keys(structuredOutcomes).length > 0 ? structuredOutcomes : undefined,
  );

  console.log(`Registered: ${manifest.skill} v${manifest.version} (${allFiles.length} files)`);
}

// Print final state
const state = readState();
console.log(`\nState now has ${state.applied_skills.length} applied skill(s):`);
for (const skill of state.applied_skills) {
  console.log(`  - ${skill.name} v${skill.version} (${Object.keys(skill.file_hashes).length} files)`);
}

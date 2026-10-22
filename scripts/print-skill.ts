// Prints the repository copy of the Agent Skill (skills/dropway/SKILL.md).
// Run: npm run skill:sync. test/discovery.test.ts fails when the file is out of date.
import { skillMarkdown } from "../packages/server/src/discovery";

process.stdout.write(skillMarkdown(null));

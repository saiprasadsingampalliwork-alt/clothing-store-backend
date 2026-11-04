/**
 * Sets a staff member's password, e.g. to replace the seeded ones (they are visible in the public repository).
 *
 *   npm run staff:password -- owner@earthen.in
 *
 * Asks for the new password without showing it. Uses DATABASE_URL to pick the database.
 */
import { createInterface } from "readline";
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

function ask(question: string) {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide what is typed.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (text.includes(question)) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const email = (process.argv[2] ?? "").trim().toLowerCase();
  if (!email) throw new Error("Usage: npm run staff:password -- <staff email>");
  const prisma = new PrismaClient();
  try {
    const member = await prisma.staff.findUnique({ where: { email } });
    if (!member) throw new Error(`No staff member uses ${email}.`);
    const password = await ask(`New password for ${member.name} (${member.role}): `);
    if (password.length < 12) throw new Error("Use at least 12 characters.");
    if ((await ask("Type it again: ")) !== password) throw new Error("The two passwords did not match.");
    await prisma.staff.update({ where: { email }, data: { passwordHash: await hash(password, 10) } });
    console.log(`Password changed for ${email}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

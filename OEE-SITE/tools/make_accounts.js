// Makes the login accounts: 2 managers, 10 workers.
//   node tools/make_accounts.js           (stops if accounts already exist)
//   node tools/make_accounts.js --force   (new passwords for everyone)
// Writes:
//   accounts.csv     email,password,role  -> hand out to people, never commit (in .gitignore)
//   auth/users.json  email, role, salt, scrypt hash -> what the server checks; no passwords in it
// Passwords are printed nowhere; open accounts.csv to read them.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CSV = path.join(ROOT, "accounts.csv");
const USERS = path.join(ROOT, "auth", "users.json");
const DOMAIN = "oee-l01.test";                       // .test is reserved: these addresses can never be real mailboxes
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";   // no 0/O, 1/l/I

if ((fs.existsSync(CSV) || fs.existsSync(USERS)) && !process.argv.includes("--force")) {
  console.error("Accounts already exist (accounts.csv / auth/users.json). Use --force to replace every password.");
  process.exit(1);
}

const password = (n = 12) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
const accounts = [
  ...[1, 2].map((i) => ({ email: `manager${i}@${DOMAIN}`, role: "manager" })),
  ...Array.from({ length: 10 }, (_, i) => ({ email: `worker${String(i + 1).padStart(2, "0")}@${DOMAIN}`, role: "worker" })),
].map((a) => ({ ...a, password: password() }));

const users = accounts.map((a) => {
  const salt = crypto.randomBytes(16);
  return { email: a.email, role: a.role, salt: salt.toString("hex"), hash: crypto.scryptSync(a.password, salt, 64).toString("hex") };
});

fs.mkdirSync(path.dirname(USERS), { recursive: true });
fs.writeFileSync(CSV, "email,password,role\r\n" + accounts.map((a) => `${a.email},${a.password},${a.role}`).join("\r\n") + "\r\n");
fs.writeFileSync(USERS, JSON.stringify(users, null, 2) + "\n");
console.log(`Made ${accounts.length} accounts (2 managers, 10 workers).`);
console.log(`  ${path.relative(ROOT, CSV)}  -> hand out, keep out of git`);
console.log(`  ${path.relative(ROOT, USERS)}  -> hashes for the server`);
console.log("Restart node server.js to load them.");

import { hashPassword } from '../src/auth/password.ts';

if (process.stdin.isTTY) {
  console.error('비밀번호를 표준 입력으로 전달하세요. README.md의 계정 설정을 참고하세요.');
  process.exit(1);
}

process.stdin.setEncoding('utf8');
let password = '';
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 256) {
    console.error('비밀번호는 12~128자로 설정하세요.');
    process.exit(1);
  }
}

const length = [...password].length;
if (length < 12 || length > 128) {
  console.error('비밀번호는 12~128자로 설정하세요.');
  process.exit(1);
}

console.log(await hashPassword(password));

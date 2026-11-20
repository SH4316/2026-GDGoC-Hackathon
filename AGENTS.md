## Git worktree

- 작업을 시작할 때 저장소 루트의 `.worktree/` 아래에 작업 브랜치용 Git worktree를 만들고, 그 안에서 변경과 검증을 진행한다.
- 작업이 완료되면 변경사항을 커밋하고 작업 브랜치를 병합 대상 브랜치에 병합한다.

## Plan mode

- Ask the user whenever an architecture or technology stack decision is required; do not make that decision on their behalf.
- Before asking questions, clearly explain the current architecture, including the relevant components, their responsibilities and interactions, and how the proposed changes would affect them. Ground the explanation in the code and documentation, and distinguish verified facts from unknowns.
- Before writing the plan, help the user understand the proposed changes and decide the relevant details by presenting concrete options, trade-offs, and recommendations. Wait for their decisions before finalizing any dependent parts of the plan.
- Write plans around the concrete scope of modifications rather than broad goals. Identify the components, files, interfaces, and behaviors to change, the boundaries of the change, and how the changes will be verified.

## 사용자 인터페이스 문구

- 장식용 슬로건, 감성적인 수식, 기능을 홍보하는 문구, 화면에서 이미 명확한 동작을 반복 설명하는 안내를 임의로 추가하지 않는다.
- 기본적으로 짧은 조작 이름과 실제 데이터만 표시한다. 설명은 사용자의 선택·실행·오류 복구 또는 명확하지 않은 제약 이해에 필요한 경우에만 추가한다.
- 빈 상태나 여백을 불필요한 문장으로 채우지 않는다. 사용자 요청 없이 예시 입력값이나 가짜 데이터를 기본 화면에 넣지 않는다.

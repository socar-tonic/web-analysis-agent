# 기본 (humax 정상)
pnpm run agent:login-graph inputs/humax-normal.json

# aj 테스트
pnpm run agent:login-graph inputs/aj-normal.json

# 에러 케이스
pnpm run agent:login-graph inputs/humax-wrong-pwd.json                                                           
pnpm run agent:login-graph inputs/humax-unreachable.json                                                     
pnpm run agent:login-graph inputs/humax-wrong-systemCode.json

# 스펙 변경 감지 테스트
cp specs/test/humax-param-changed.json specs/humax-parcs-api.json                                                
pnpm run agent:login-graph inputs/humax-normal.json    

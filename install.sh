#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Ravan RTL — Linux installer' 'Usage: bash install.sh [--full | --font-only | --restore | --diagnose] [--path /path/to/app.asar]' 'Quit Claude Desktop completely before applying or restoring. The GUI is never launched as root.'
}
mode=--full
app_path=
selected=0
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --full|--font-only|--restore|--diagnose)
      ((selected == 0)) || { printf '%s\n' 'Choose only one operation.' >&2; exit 1; }
      mode=$1; selected=1; shift ;;
    --path)
      (($# >= 2)) || { printf '%s\n' '--path requires a value.' >&2; exit 1; }
      [[ -z "$app_path" ]] || { printf '%s\n' 'Specify --path only once.' >&2; exit 1; }
      app_path=$2; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done
[[ $(uname -s) == Linux ]] || { printf '%s\n' 'Only Linux is supported.' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { printf '%s\n' 'Run this installer as your normal user, not root.' >&2; exit 1; }
for tool in node npm /usr/bin/python3; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'Missing required dependency: %s\n' "$tool" >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22 || (a===22 && b<12)) { console.error("Node.js 22.12.0 or newer is required."); process.exit(1); }'
node_bin=$(command -v node)
project_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ -d "$project_dir/node_modules" ]]; then
  npm --prefix "$project_dir" ls --all --omit=dev --silent >/dev/null || { printf '%s\n' 'Existing dependencies are incomplete; inspect them before running npm ci manually.' >&2; exit 1; }
else
  npm --prefix "$project_dir" ci --ignore-scripts --no-audit --no-fund
fi
path_args=()
[[ -z "$app_path" ]] || path_args=(--path "$app_path")
report=$("$node_bin" "$project_dir/index.js" --diagnose --json "${path_args[@]}")
printf '%s\n' "$report"
[[ "$mode" != --diagnose ]] || exit 0
asar_path=$(printf '%s' "$report" | "$node_bin" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).asarPath))')
executable_path=$(printf '%s' "$report" | "$node_bin" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).executablePath || ""))')
[[ -n "$executable_path" ]] || { printf '%s\n' 'Cannot verify the application executable; specify its path with --path.' >&2; exit 1; }
archive_owner=$("$node_bin" -e 'process.stdout.write(String(require("node:fs").statSync(process.argv[1]).uid))' "$asar_path")
if [[ -w $(dirname -- "$asar_path") && "$archive_owner" == "$(id -u)" ]]; then
  exec "$node_bin" "$project_dir/index.js" "$mode" --path "$executable_path"
fi
command -v pkexec >/dev/null 2>&1 || { printf '%s\n' 'The installation needs administrator access. Install a PolicyKit agent or consult your system documentation for an authorized privilege mechanism.' >&2; exit 1; }
printf '%s\n' 'Administrator authentication is required to modify the application archive.'
exec pkexec "$node_bin" "$project_dir/index.js" "$mode" --path "$executable_path"

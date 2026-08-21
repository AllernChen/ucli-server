#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/conf/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/conf/.env"
COMPOSE=()

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
err() { printf '[%s] ERROR: %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }

detect_compose() {
  command -v docker >/dev/null 2>&1 || { err 'Docker Engine 未安装'; exit 1; }
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version --short | grep -Eq '^2\.'; then
    COMPOSE=(docker-compose)
  else
    err '需要 Docker Compose v2'
    exit 1
  fi
}

check_deps() {
  detect_compose
  [ -f "$COMPOSE_FILE" ] || { err "缺少 $COMPOSE_FILE"; exit 1; }
  [ -f "$ENV_FILE" ] || { err "缺少 $ENV_FILE，请从 conf/.env.example 创建并填写"; exit 1; }
}

compose() {
  "${COMPOSE[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

load_images() {
  local found=0
  for image_file in "$SCRIPT_DIR"/images/*.tar.gz "$SCRIPT_DIR"/images/*.tar; do
    [ -f "$image_file" ] || continue
    log "加载镜像：$(basename "$image_file")"
    docker load -i "$image_file"
    found=$((found + 1))
  done
  [ "$found" -gt 0 ] || { err 'images/ 中没有镜像归档'; exit 1; }
}

check_ports() {
  local rendered port
  rendered="$(compose config)"
  while IFS= read -r port; do
    [ -n "$port" ] || continue
    if ss -lnt 2>/dev/null | grep -q ":${port} "; then
      log "警告：宿主机端口 $port 已被占用，请确认是否为当前项目"
    fi
  done < <(printf '%s\n' "$rendered" | sed -n 's/.*published: "\{0,1\}\([0-9][0-9]*\)"\{0,1\}.*/\1/p')
}

deploy_stack() {
  log '执行数据库迁移'
  compose run --rm migrate
  log '启动 API、Gateway、Worker 和 Web'
  compose up -d --remove-orphans api gateway worker web
}

cmd_install() {
  check_deps
  load_images
  check_ports
  deploy_stack
  cmd_status
}

cmd_start() { check_deps; compose start; }
cmd_stop() { check_deps; compose stop; }
cmd_restart() { check_deps; compose restart; }
cmd_status() { check_deps; compose ps; }
cmd_logs() { check_deps; compose logs -f --tail=100 "${2:-}"; }
cmd_update() { check_deps; load_images; deploy_stack; cmd_status; }

cmd_uninstall() {
  check_deps
  log '将删除 UCLI Server 容器和专用网络；外部中间件与数据不会删除'
  read -r -p '输入 yes 确认：' confirmation
  [ "$confirmation" = yes ] || { log '已取消'; return; }
  compose down
}

usage() {
  cat <<'EOF'
用法：./install.sh <命令> [服务]
  install    加载镜像、迁移数据库并启动
  start      启动已有容器
  stop       停止容器
  restart    重启容器
  status     查看状态
  logs       查看日志，可指定服务
  update     加载新镜像、迁移并重建
  uninstall  删除应用容器，保留外部中间件数据
EOF
}

case "${1:-}" in
  install) cmd_install ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  update) cmd_update ;;
  uninstall) cmd_uninstall ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac

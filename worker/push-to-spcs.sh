#!/bin/bash
# Push the worker image to the Snowflake image registry, surviving token expiry.
#
# The registry session token lasts ~58 minutes and the upload path sustains
# ~2.4 MB/s, so a multi-gigabyte image cannot always finish inside one token.
# Every blob the registry accepts is retained, though, so a re-push after
# re-authenticating resumes rather than restarting — provided no single layer is
# too big to ever complete (see the Dockerfile header on layer sizing).
#
# This loop therefore just does: push, and if it fails, log in again and push
# again. It stops on success, on a non-auth error that repeats, or at the attempt
# cap so it cannot spin forever.
set -o pipefail

# Set these for your own account, or override them in the environment:
#   SNOWFLAKE_CONN  your connection name from ~/.snowflake/connections.toml
#   REGISTRY        <org>-<account>.registry.snowflakecomputing.com, lowercased
#                   with underscores turned into hyphens
# Find the registry host with: SHOW IMAGE REPOSITORIES IN SCHEMA NARRATOR.IMAGES;
CONN="${SNOWFLAKE_CONN:-my_connection}"
REGISTRY="${REGISTRY:-my-org-my-account.registry.snowflakecomputing.com}"
IMAGE="${IMAGE:-${REGISTRY}/narrator/images/repo/narrator-worker:v2}"
MAX_ATTEMPTS=12
LOG=/tmp/push_loop.log

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# Kill a push that has stopped making progress.
#
# When the registry token expires mid-upload, `docker push` does NOT reliably
# exit: it can sit in a retry/hang state indefinitely, moving only TCP
# keepalives. Observed once at 38 minutes of complete silence. A loop that waits
# for the process to exit therefore waits forever.
#
# Progress is judged by BYTES ON THE WIRE, not by the log growing. Docker's push
# output is legitimately silent for minutes at a time while it prepares and
# compresses a large layer — an earlier version of this watchdog watched the log
# and killed a perfectly healthy push after five quiet minutes. Bytes cannot lie:
# a live upload here sustains ~2 MB/s, while a hung one shows only keepalives.
STALL_SECONDS=${STALL_SECONDS:-600}
# Minimum bytes per 60s sample to count as "still working". Background chatter is
# a few KB; a real upload is two orders of magnitude above this.
MIN_BYTES_PER_SAMPLE=${MIN_BYTES_PER_SAMPLE:-3000000}

bytes_out() {
    # Sum transmitted bytes across every non-loopback interface. Which interface
    # carries the upload depends on how the VPN is routed, so do not assume one.
    netstat -ib 2>/dev/null | awk '!/^Name/ && $1!~/^lo/ {s[$1]+=$10} END{t=0; for(i in s) t+=s[i]; print t+0}'
}

watch_for_stall() {
    local pid=$1 quiet=0 before after delta
    while kill -0 "$pid" 2>/dev/null; do
        before=$(bytes_out)
        sleep 60
        kill -0 "$pid" 2>/dev/null || return 0
        after=$(bytes_out)
        delta=$(( after - before ))
        if [ "$delta" -ge "$MIN_BYTES_PER_SAMPLE" ]; then
            quiet=0
        else
            quiet=$((quiet + 60))
            log "  (no upload progress for ${quiet}s; last sample $(( delta/1024 )) KB)"
            if [ "$quiet" -ge "$STALL_SECONDS" ]; then
                log "STALLED: ${quiet}s without meaningful upload — killing push $pid to retry with a fresh token"
                kill -9 "$pid" 2>/dev/null
                return 0
            fi
        fi
    done
}

log "=== push loop starting for $IMAGE ==="
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    log "--- attempt $attempt/$MAX_ATTEMPTS: refreshing registry login ---"
    if ! snow spcs image-registry login -c "$CONN" >>"$LOG" 2>&1; then
        log "LOGIN FAILED (VPN down? network policy?). Sleeping 60s before retry."
        sleep 60
        continue
    fi

    log "pushing (attempt $attempt)…"
    : > /tmp/push_attempt.log
    docker push "$IMAGE" > /tmp/push_attempt.log 2>&1 &
    push_pid=$!
    watch_for_stall "$push_pid" &
    watchdog_pid=$!
    wait "$push_pid"
    rc=$?
    kill "$watchdog_pid" 2>/dev/null
    wait "$watchdog_pid" 2>/dev/null

    pushed=$(tr '\r' '\n' < /tmp/push_attempt.log | grep -c ': Pushed')
    exists=$(tr '\r' '\n' < /tmp/push_attempt.log | grep -c 'Layer already exists')

    if [ "$rc" -eq 0 ]; then
        log "PUSH SUCCEEDED on attempt $attempt"
        tr '\r' '\n' < /tmp/push_attempt.log | grep -a "digest:" | tail -1 | tee -a "$LOG"
        log "layers pushed this attempt: $pushed | already present: $exists"
        exit 0
    fi

    tail_out=$(tr '\r' '\n' < /tmp/push_attempt.log | grep -aiE "error|denied|unauthorized|timeout|EOF" | tail -2 | tr '\n' ' ')
    log "attempt $attempt failed (rc=$rc): ${tail_out:-<killed or no error line>}"
    # Every completed blob is retained by the registry, so this number is the
    # progress that the next attempt will not have to repeat.
    log "layers banked this attempt: $pushed | already present at start: $exists"
    sleep 10
done

log "=== GAVE UP after $MAX_ATTEMPTS attempts ==="
exit 1

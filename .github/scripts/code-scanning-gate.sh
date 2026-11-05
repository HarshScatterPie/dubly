#!/usr/bin/env bash
# Release gate: waits for GitHub's CodeQL analysis of this very commit, then fails while any open code-scanning alert is
# high or critical, except the rules in ALLOWED_RULES (comma-separated; each one's reason is written next to it in
# .github/workflows/release-gate.yml). Every open alert is listed in the job summary either way.
set -euo pipefail

: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${GH_TOKEN:?}"
REF="${GITHUB_REF:-refs/heads/main}"
# The default setup analyses two languages here: JavaScript/TypeScript and the workflows themselves.
EXPECTED_ANALYSES="${EXPECTED_ANALYSES:-2}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

analysed=0
for _ in $(seq 1 60); do
  analysed=$(gh api "repos/$GITHUB_REPOSITORY/code-scanning/analyses?ref=$REF&per_page=100" \
    --jq "[.[] | select(.commit_sha == \"$GITHUB_SHA\")] | length")
  [ "$analysed" -ge "$EXPECTED_ANALYSES" ] && break
  sleep 20
done
if [ "$analysed" -lt "$EXPECTED_ANALYSES" ]; then
  echo "::error title=Code scanning::CodeQL had not analysed $GITHUB_SHA after 20 minutes ($analysed of $EXPECTED_ANALYSES analyses)."
  exit 1
fi

alerts=$(gh api --paginate "repos/$GITHUB_REPOSITORY/code-scanning/alerts?ref=$REF&state=open&per_page=100" \
  --jq '.[] | [.number, (.rule.security_severity_level // .rule.severity // "none"), .rule.id, .most_recent_instance.location.path, .most_recent_instance.location.start_line] | @tsv')

blocking=0
# The table goes to the job summary; annotations (workflow commands) must reach the real stdout.
exec 3>&1
{
  echo "## Release gate: open code-scanning alerts"
  echo
  if [ -z "$alerts" ]; then
    echo "None."
  else
    echo "| Alert | Severity | Rule | Where | Blocks deploy |"
    echo "|---|---|---|---|---|"
    while IFS=$'\t' read -r number severity rule file line; do
      blocks=no
      if { [ "$severity" = high ] || [ "$severity" = critical ]; } && [[ ",${ALLOWED_RULES:-}," != *",$rule,"* ]]; then
        blocks=yes
        blocking=$((blocking + 1))
        echo "::error file=$file,line=$line,title=Code scanning alert #$number::$rule ($severity)" >&3
      fi
      echo "| #$number | $severity | \`$rule\` | \`$file:$line\` | $blocks |"
    done <<< "$alerts"
  fi
  echo
} >> "$SUMMARY"

if [ "$blocking" -gt 0 ]; then
  echo "$blocking open high or critical code-scanning alert(s); fix them, or dismiss false positives on GitHub, before this can deploy." >&2
  exit 1
fi
echo "No blocking code-scanning alerts."

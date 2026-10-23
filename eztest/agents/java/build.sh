#!/bin/sh
# Build EZTest's Java desktop agent: ez-java-agent.jar (JDK 11+; no dependencies).
# Usage: agents/java/build.sh [output-dir]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/build"}
mkdir -p "$out/classes"
javac --release 11 -d "$out/classes" "$here"/src/dev/eztest/agent/*.java
printf 'Premain-Class: dev.eztest.agent.EzAgent\nAgent-Class: dev.eztest.agent.EzAgent\n' > "$out/MANIFEST.MF"
jar cfm "$out/ez-java-agent.jar" "$out/MANIFEST.MF" -C "$out/classes" .
echo "$out/ez-java-agent.jar"

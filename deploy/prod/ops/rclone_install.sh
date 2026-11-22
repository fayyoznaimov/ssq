set -e
if command -v rclone >/dev/null; then rclone version | head -1; exit 0; fi
T=$(mktemp -d); cd $T
V=$(curl -fsS https://downloads.rclone.org/version.txt | awk '{print $2}')
echo "official release: $V"
curl -fsS -o rclone.zip "https://downloads.rclone.org/$V/rclone-$V-linux-amd64.zip"
curl -fsS -o SHA256SUMS "https://downloads.rclone.org/$V/SHA256SUMS"
want=$(grep "rclone-$V-linux-amd64.zip" SHA256SUMS | awk '{print $1}'); got=$(sha256sum rclone.zip | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "checksum mismatch, not installed"; exit 1; }
echo "checksum matches the published one"
python3 -c "import zipfile; zipfile.ZipFile('rclone.zip').extract('rclone-$V-linux-amd64/rclone', '.')"
install -m 755 "rclone-$V-linux-amd64/rclone" /usr/local/bin/rclone
cd /; rm -rf $T
rclone version | head -1

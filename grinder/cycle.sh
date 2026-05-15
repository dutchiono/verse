#!/bin/bash
set -e

echo "Backing up words.txt..."
cp words.txt "words.backup.$(date +%Y%m%d-%H%M%S).txt"

echo "Sorting words.txt safely..."
sort -u words.txt -o words.txt

echo "Running manager.py..."
python3 manager.py . -w words.txt -o wallet_management.csv

echo ""
echo "Running listcheck.py..."
python3 listcheck.py

echo ""
echo "=============================="
echo "REMAINING TO GRIND"
echo "=============================="
cat remaining_words.txt

echo ""
echo "=============================="
echo "ORPHAN CHECK"
echo "=============================="
python3 orphan_check.py

echo ""
echo "=============================="
echo "CURATING PAIRS"
echo "=============================="
python3 curate.py

echo ""
echo "Done."

#!/usr/bin/env python3
"""
Reads wallet_management.csv and produces curated.csv containing only
complete PREFIX+SUFFIX pairs, minus anything in omit.txt.

omit.txt format (one entry per line, # = comment):
  - Short word  e.g.  DUTCH        → omit the entire pair for that word
  - Wallet addr e.g.  LARPMoAem…  → omit that specific wallet only

Run standalone:  python3 curate.py
Or via:          ./cycle.sh
"""
import csv
from pathlib import Path
from collections import defaultdict

CSV_FILE    = "wallet_management.csv"
OMIT_FILE   = "omit.txt"
OUTPUT_FILE = "curated.csv"

FIELDNAMES = ["Word", "Type", "Short Wallet", "Wallet Address", "Private Key", "Source File"]


def load_omits(path: str) -> tuple[set[str], set[str]]:
    """Returns (omit_words, omit_addrs). Words are stored lowercased for matching."""
    p = Path(path)
    if not p.exists():
        return set(), set()

    omit_words: set[str] = set()
    omit_addrs: set[str] = set()

    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # Wallet addresses are long; words are short
        if len(line) > 20:
            omit_addrs.add(line)
        else:
            omit_words.add(line.lower())   # match case-insensitively

    return omit_words, omit_addrs


def main():
    if not Path(CSV_FILE).exists():
        print(f"ERROR: {CSV_FILE} not found — run cycle.sh first.")
        return

    omit_words, omit_addrs = load_omits(OMIT_FILE)

    # Read all rows
    rows: list[dict] = []
    with open(CSV_FILE, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    # Group by word
    by_word: dict[str, dict[str, dict]] = defaultdict(dict)
    for row in rows:
        by_word[row["Word"]][row["Type"]] = row

    included: list[dict] = []
    skipped_incomplete: list[str] = []
    skipped_omit_word:  list[str] = []
    skipped_omit_addr:  list[str] = []

    for word, types in sorted(by_word.items(), key=lambda x: x[0].lower()):
        has_prefix = "Prefix" in types
        has_suffix = "Suffix" in types

        # Must have both
        if not (has_prefix and has_suffix):
            skipped_incomplete.append(
                word + (" (missing prefix)" if has_suffix else
                        " (missing suffix)" if has_prefix else
                        " (missing both)")
            )
            continue

        # Word-level omit (case-insensitive)
        if word.lower() in omit_words:
            skipped_omit_word.append(word)
            continue

        # Address-level omit — if either half is omitted, drop the whole pair
        addr_omitted = False
        for typ in ("Prefix", "Suffix"):
            if types[typ]["Wallet Address"] in omit_addrs:
                skipped_omit_addr.append(f"{word} {typ} ({types[typ]['Short Wallet']})")
                addr_omitted = True
                break

        if addr_omitted:
            continue

        included.append(types["Prefix"])
        included.append(types["Suffix"])

    # Write output
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(included)

    pair_count = len(included) // 2

    print(f"\n{'='*54}")
    print(f"  CURATED CSV  →  {OUTPUT_FILE}")
    print(f"{'='*54}")
    print(f"  ✓  {pair_count} pair(s) included  ({len(included)} wallets)")

    if skipped_incomplete:
        print(f"\n  INCOMPLETE (skipped — need both sides to be a pair):")
        for s in skipped_incomplete:
            print(f"    {s}")

    if skipped_omit_word:
        print(f"\n  OMITTED WORDS (from omit.txt):")
        for s in skipped_omit_word:
            print(f"    {s}")

    if skipped_omit_addr:
        print(f"\n  OMITTED WALLETS (from omit.txt):")
        for s in skipped_omit_addr:
            print(f"    {s}")

    print()


if __name__ == "__main__":
    main()

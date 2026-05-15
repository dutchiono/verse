#!/usr/bin/env python3
"""
Scans all .json wallet files and flags any that are NOT matched by
any word in words.txt — these are "orphaned" grinds you forgot to
register first.

Run standalone:  python3 orphan_check.py
Or via:          ./cycle.sh
"""
import re
import json
from pathlib import Path

import base58
from nacl.signing import SigningKey

WORDS_FILE = "words.txt"
WALLET_DIR = "."


def load_words(path: str) -> list[str]:
    return [
        line.strip()
        for line in Path(path).read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def to_pubkey(path: Path) -> str | None:
    try:
        nums = json.loads(path.read_text(encoding="utf-8"))
        if len(nums) == 32:
            pub = SigningKey(bytes(nums)).verify_key.encode()
        elif len(nums) == 64:
            pub = bytes(nums[32:])
        else:
            return None
        return base58.b58encode(pub).decode("ascii")
    except Exception:
        return None


# Extract a candidate "word" from a pubkey by looking for a run of
# uppercase-ish characters at the start or end.
# Base58 uppercase: A-Z (no O/I/0/l) but vanity tools use exact chars
# so we just look for the leading/trailing cap run.
_UPPER_RUN = re.compile(r"[A-Z0-9]")


def detect_word(pubkey: str) -> tuple[str | None, str | None]:
    """Return (prefix_guess, suffix_guess) — uppercase runs at each end."""
    # Prefix: longest run of uppercase/digit chars at start
    prefix = ""
    for ch in pubkey:
        if _UPPER_RUN.match(ch):
            prefix += ch
        else:
            break

    # Suffix: longest run of uppercase/digit chars at end
    suffix = ""
    for ch in reversed(pubkey):
        if _UPPER_RUN.match(ch):
            suffix = ch + suffix
        else:
            break

    # Only report if the run is at least 3 chars (avoids noise)
    return (prefix if len(prefix) >= 3 else None,
            suffix if len(suffix) >= 3 else None)


def main():
    words = load_words(WORDS_FILE)
    words_set = set(words)

    orphans: list[tuple[str, str, str | None, str | None]] = []

    for f in sorted(Path(WALLET_DIR).glob("*.json")):
        pubkey = to_pubkey(f)
        if pubkey is None:
            continue

        matched = any(pubkey.startswith(w) or pubkey.endswith(w) for w in words)

        if not matched:
            prefix_g, suffix_g = detect_word(pubkey)
            orphans.append((f.name, pubkey, prefix_g, suffix_g))

    if not orphans:
        print("✓  No orphaned wallets — every .json matches a word in words.txt")
        return

    print(f"\n{'='*54}")
    print(f"  ⚠  ORPHANED WALLETS  ({len(orphans)} file(s) not in words.txt)")
    print(f"{'='*54}")
    print("  Add the missing word(s) to words.txt, then re-run cycle.sh\n")

    # Group guesses so we can cluster by suspected word
    by_guess: dict[str, list[tuple[str, str, str]]] = {}
    no_guess: list[tuple[str, str]] = []

    for fname, pubkey, prefix_g, suffix_g in orphans:
        short = f"{pubkey[:6]}…{pubkey[-6:]}"
        guesses = []
        if prefix_g and prefix_g not in words_set:
            guesses.append((prefix_g, "prefix", short))
        if suffix_g and suffix_g not in words_set and suffix_g != prefix_g:
            guesses.append((suffix_g, "suffix", short))

        if guesses:
            for word_g, typ_g, s in guesses:
                by_guess.setdefault(word_g, []).append((typ_g, s, fname))
        else:
            no_guess.append((short, fname))

    for word_g, entries in sorted(by_guess.items()):
        print(f"  Word \"{word_g}\" — not in words.txt:")
        for typ_g, short, fname in entries:
            print(f"    {typ_g:8s}  {short}  ({fname})")
        print()

    if no_guess:
        print("  Could not detect word for:")
        for short, fname in no_guess:
            print(f"    {short}  ({fname})")
        print()


if __name__ == "__main__":
    main()

"""Turn raw diarization turns into clean single-speaker segments.

Pure Python (no pyannote dependency) so it can be unit-tested.

Rules follow the Cinnamon guidelines:
  * one speaker only, no overlapping speech      -> overlap is cut out
  * complete utterance, don't clip edges         -> small padding, clamped
  * target duration ~30 s                         -> merge same-speaker turns up to max_dur
"""
from __future__ import annotations

from dataclasses import dataclass, asdict


@dataclass
class Seg:
    start: float
    end: float
    speaker: str

    @property
    def dur(self) -> float:
        return self.end - self.start


def _overlap_intervals(turns: list[Seg]) -> list[tuple[float, float]]:
    """Intervals where 2+ speakers are active at once (sweep line)."""
    events = []
    for t in turns:
        events.append((t.start, 1))
        events.append((t.end, -1))
    events.sort(key=lambda e: (e[0], e[1]))  # ends before starts at same time
    active, out, cur = 0, [], None
    for time, delta in events:
        prev = active
        active += delta
        if prev < 2 <= active:
            cur = time
        elif prev >= 2 > active and cur is not None:
            if time > cur:
                out.append((cur, time))
            cur = None
    return out


def _subtract(seg: Seg, holes: list[tuple[float, float]]) -> list[Seg]:
    pieces = [seg]
    for hs, he in holes:
        nxt = []
        for p in pieces:
            if he <= p.start or hs >= p.end:
                nxt.append(p)
                continue
            if hs > p.start:
                nxt.append(Seg(p.start, hs, p.speaker))
            if he < p.end:
                nxt.append(Seg(he, p.end, p.speaker))
        pieces = nxt
    return pieces


def build_segments(
    turns: list[Seg],
    duration: float,
    max_dur: float = 30.0,
    pad: float = 0.2,
    min_piece: float = 0.3,
    min_seg: float = 1.0,
    drop_overlap: bool = True,
) -> list[Seg]:
    turns = [Seg(float(t.start), float(t.end), str(t.speaker)) for t in turns if t.end > t.start]
    turns.sort(key=lambda t: t.start)

    # 1. remove overlapped speech
    if drop_overlap:
        holes = _overlap_intervals(turns)
        pieces = [p for t in turns for p in _subtract(t, holes)]
    else:
        pieces = list(turns)
    pieces = [p for p in pieces if p.dur >= min_piece]
    pieces.sort(key=lambda p: p.start)

    # 2. merge consecutive pieces of the same speaker (no other speaker in between)
    merged: list[Seg] = []
    for p in pieces:
        if merged:
            cur = merged[-1]
            same = cur.speaker == p.speaker
            len_ok = max_dur <= 0 or (p.end - cur.start) <= max_dur
            # nobody else (including overlap) may speak inside the gap
            clean_gap = not any(
                t.speaker != p.speaker and t.start < p.start and t.end > cur.end
                for t in turns
            )
            if same and len_ok and clean_gap:
                cur.end = max(cur.end, p.end)
                continue
        merged.append(Seg(p.start, p.end, p.speaker))

    # 3. pad edges, clamped so we never reach into a neighbour's speech
    #    (all speech, including overlap regions, counts as a neighbour)
    out: list[Seg] = []
    for i, s in enumerate(merged):
        lo = 0.0
        hi = duration if duration > 0 else s.end + pad
        for t in turns:
            if t.speaker == s.speaker and t.start >= s.start - 1e-6 and t.end <= s.end + 1e-6:
                continue
            if t.end <= s.start + 1e-6:
                lo = max(lo, t.end)
            if t.start >= s.end - 1e-6:
                hi = min(hi, t.start)
        if i > 0:
            lo = max(lo, out[-1].end if out else 0.0)
        start = max(lo, s.start - pad) if lo <= s.start else s.start
        end = min(hi, s.end + pad) if hi >= s.end else s.end
        out.append(Seg(round(start, 3), round(end, 3), s.speaker))

    return [s for s in out if s.dur >= min_seg]


def to_dicts(segs: list[Seg]) -> list[dict]:
    return [asdict(s) for s in segs]

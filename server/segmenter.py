"""Turn raw diarization turns into clean single-speaker segments.

Pure Python (no pyannote dependency) so it can be unit-tested.

Rules follow the Cinnamon guidelines:
  * one speaker only, no overlapping speech      -> overlap is cut out
  * complete utterance, don't clip edges         -> small padding, clamped
  * target duration ~30 s                         -> join same-speaker turns, then split anything longer
                                                     than max_dur at a pause (or the quietest moment)
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Callable, Optional


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


def _split_run(run: list[Seg], limit: float, min_pause: float,
               quiet_point: Optional[Callable[[float, float], Optional[float]]]) -> list[Seg]:
    """Split one speaker's run into segments of at most `limit` seconds.

    Prefers the latest pause before the limit that is long enough for padding on both sides
    (>= min_pause). If there is none in the second half of the window, cuts at the quietest moment
    of the audio there instead (one long turn); without audio it falls back to the latest pause, then
    to a hard cut at the limit.
    """
    spk, end = run[0].speaker, max(q.end for q in run)
    gaps: list[tuple[float, float]] = []  # silences between the run's pieces: (left end, right start)
    reach = run[0].end
    for q in run[1:]:
        if q.start > reach:
            gaps.append((reach, q.start))
        reach = max(reach, q.end)
    pauses = [g for g in gaps if g[1] - g[0] >= min_pause - 1e-9]

    out: list[Seg] = []
    start = run[0].start
    while end - start > limit + 1e-9:
        cap = start + limit
        fits = [g for g in pauses if start < g[0] <= cap]
        cut = fits[-1] if fits and fits[-1][0] - start >= limit / 2 else None
        if cut is None and quiet_point is not None:
            t = quiet_point(start + limit / 2, cap)
            if t is not None and start < t <= cap:
                # landing in a short silence: cut around it rather than through it
                cut = next(((g0, g1) for g0, g1 in gaps if g0 <= t <= g1), (t, t))
        if cut is None:
            cut = fits[-1] if fits else (cap, cap)
        out.append(Seg(start, cut[0], spk))
        start = cut[1]
    out.append(Seg(start, end, spk))
    return out


def build_segments(
    turns: list[Seg],
    duration: float,
    max_dur: float = 30.0,
    pad: float = 0.2,
    min_piece: float = 0.3,
    min_seg: float = 1.0,
    drop_overlap: bool = True,
    quiet_point: Optional[Callable[[float, float], Optional[float]]] = None,
) -> list[Seg]:
    """quiet_point(lo, hi) -> time of the quietest moment in [lo, hi] (from the audio), or None.
    Used to split one long turn that has no usable pause before max_dur."""
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

    # 2. join consecutive pieces of the same speaker while nobody else (including overlap) speaks in between
    runs: list[list[Seg]] = []
    for p in pieces:
        if runs and runs[-1][-1].speaker == p.speaker:
            last_end = max(q.end for q in runs[-1])
            if not any(t.speaker != p.speaker and t.start < p.start and t.end > last_end for t in turns):
                runs[-1].append(p)
                continue
        runs.append([p])

    # 3. split runs longer than max_dur. The limit leaves room for padding on both sides,
    #    so finished segments stay within max_dur.
    limit = max_dur - 2 * pad if max_dur > 2 * pad else max_dur
    merged: list[Seg] = []
    for run in runs:
        if limit > 0:
            merged.extend(_split_run(run, limit, 2 * pad, quiet_point))
        else:
            merged.append(Seg(run[0].start, max(q.end for q in run), run[0].speaker))
    merged.sort(key=lambda s: s.start)

    # 4. pad edges, clamped so we never reach into a neighbour's speech
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
        for m in merged[i + 1:]:  # nor into the next segment (a split inside one turn has no gap)
            if m.start >= s.end - 1e-6:
                hi = min(hi, m.start)
                break
        start = max(lo, s.start - pad) if lo <= s.start else s.start
        end = min(hi, s.end + pad) if hi >= s.end else s.end
        out.append(Seg(round(start, 3), round(end, 3), s.speaker))

    return [s for s in out if s.dur >= min_seg]


def to_dicts(segs: list[Seg]) -> list[dict]:
    return [asdict(s) for s in segs]

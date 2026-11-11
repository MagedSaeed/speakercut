import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "server"))
from segmenter import Seg, build_segments


def spans(segs):
    return [(s.speaker, s.start, s.end) for s in segs]


def no_overlap_between_speakers(segs, turns):
    for s in segs:
        for t in turns:
            if t.speaker != s.speaker:
                assert t.end <= s.start + 1e-6 or t.start >= s.end - 1e-6, (s, t)


def test_merge_same_speaker_turns():
    turns = [Seg(0.5, 3, "A"), Seg(3.5, 6, "A"), Seg(7, 10, "B"), Seg(10.5, 12, "B")]
    out = build_segments(turns, 15, pad=0)
    assert spans(out) == [("A", 0.5, 6), ("B", 7, 12)]


def test_overlap_removed_and_not_bridged():
    # A talks 0-10, B interjects 4-5 (overlap). A's segment must not contain 4-5.
    turns = [Seg(0, 10, "A"), Seg(4, 5, "B")]
    out = build_segments(turns, 12, pad=0, min_seg=0.5)
    assert ("A", 0, 4) in spans(out) and ("A", 5, 10) in spans(out)
    assert all(s.speaker == "A" for s in out)  # B's piece is fully overlapped
    for s in out:
        assert not (s.start < 5 and s.end > 4)


def test_max_dur_splits():
    turns = [Seg(i * 5, i * 5 + 4.5, "A") for i in range(10)]  # 50 s of A
    out = build_segments(turns, 60, pad=0, max_dur=30)
    assert len(out) == 2 and all(s.dur <= 30 for s in out)
    assert build_segments(turns, 60, pad=0, max_dur=0)[0].dur > 40  # unlimited


def test_padding_clamped_to_neighbours():
    turns = [Seg(1.0, 3.0, "A"), Seg(3.1, 6.0, "B")]
    out = build_segments(turns, 8, pad=0.3)
    a, b = out
    assert a.start == 0.7 and a.end == 3.1  # clamped at B's start
    assert b.start == 3.1 and b.end == 6.3
    no_overlap_between_speakers(out, turns)


def test_padding_clamped_to_file_bounds_and_min_seg():
    turns = [Seg(0.05, 0.6, "A"), Seg(1, 5.9, "B")]
    out = build_segments(turns, 6, pad=0.2, min_seg=1.0)
    assert spans(out) == [("B", 0.8, 6.0)]


def test_large_gap_not_merged():
    turns = [Seg(0, 3, "A"), Seg(8, 11, "A")]
    out = build_segments(turns, 12, pad=0, max_gap=1.5)
    assert len(out) == 2

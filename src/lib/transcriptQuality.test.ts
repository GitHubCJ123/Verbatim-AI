import { describe, expect, it } from "vitest";
import {
  collapseRepetitions,
  finalizeCleanup,
  sanitizeTranscript,
  stripCleanupWrapper,
} from "./transcriptQuality";

describe("sanitizeTranscript", () => {
  it("removes whisper non-speech annotations", () => {
    expect(sanitizeTranscript("[BLANK_AUDIO]")).toBe("");
    expect(sanitizeTranscript(" [Music] Hello there. (applause)")).toBe("Hello there.");
    expect(sanitizeTranscript("Send it now [MUSIC PLAYING] please.")).toBe("Send it now please.");
    expect(sanitizeTranscript("♪ la la la ♪ okay")).toBe("okay");
    expect(sanitizeTranscript("*coughs* So the plan is fine.")).toBe("So the plan is fine.");
  });

  it("keeps ordinary parentheses and lowercase brackets the user dictated", () => {
    expect(sanitizeTranscript("Call me (after lunch) today.")).toBe("Call me (after lunch) today.");
    expect(sanitizeTranscript("Use arr[i] here.")).toBe("Use arr[i] here.");
  });

  it("drops whole-utterance subtitle hallucinations but not real phrases", () => {
    expect(sanitizeTranscript("Thanks for watching!")).toBe("");
    expect(sanitizeTranscript("Subtitles by the Amara.org community")).toBe("");
    expect(sanitizeTranscript("Thank you.")).toBe("Thank you.");
    expect(sanitizeTranscript("Thanks for watching the kids yesterday.")).toBe(
      "Thanks for watching the kids yesterday.",
    );
  });

  it("returns empty for punctuation-only output", () => {
    expect(sanitizeTranscript(" . ")).toBe("");
    expect(sanitizeTranscript("")).toBe("");
  });
});

describe("collapseRepetitions", () => {
  it("collapses decoder loops", () => {
    expect(collapseRepetitions("the the the the the the the end")).toBe("the end");
    expect(
      collapseRepetitions("I think so. I think so. I think so. I think so. Okay"),
    ).toBe("I think so. Okay");
  });

  it("leaves natural repetition alone", () => {
    expect(collapseRepetitions("no, no, no, I said tomorrow")).toBe("no, no, no, I said tomorrow");
    expect(collapseRepetitions("very very good")).toBe("very very good");
  });
});

describe("stripCleanupWrapper", () => {
  it("removes chat preambles, quotes, fences and reasoning", () => {
    expect(stripCleanupWrapper("Here is the cleaned text: Hello world.")).toBe("Hello world.");
    expect(stripCleanupWrapper("Sure! Here's the polished transcript:\nHi team.")).toBe("Hi team.");
    expect(stripCleanupWrapper('"Meet at noon."')).toBe("Meet at noon.");
    expect(stripCleanupWrapper("```\nfoo bar\n```")).toBe("foo bar");
    expect(stripCleanupWrapper("<think>hmm</think>Final text.")).toBe("Final text.");
    expect(stripCleanupWrapper("<transcript>Done.</transcript>")).toBe("Done.");
  });

  it("keeps internal quotes", () => {
    expect(stripCleanupWrapper('"Yes," she said, "fine."')).toBe('"Yes," she said, "fine."');
  });
});

describe("finalizeCleanup", () => {
  it("falls back to the transcript when the model returns nothing", () => {
    expect(finalizeCleanup("hello there", "  ")).toEqual({ text: "hello there", usedFallback: true });
  });

  it("falls back when the model writes an essay instead of an edit", () => {
    const transcript = "what is the best way to learn rust";
    const answer = "The best way to learn Rust is ".padEnd(600, "x");
    expect(finalizeCleanup(transcript, answer).usedFallback).toBe(true);
  });

  it("allows expanding modes and translation", () => {
    const email = "Hi there,\n\nThe meeting has moved to Friday.\n\nBest,\nSam";
    expect(finalizeCleanup("tell them the meeting moved to friday", email)).toEqual({
      text: email,
      usedFallback: false,
    });
    expect(
      finalizeCleanup("hola", "Hello ".repeat(100), { translating: true }).usedFallback,
    ).toBe(false);
  });
});

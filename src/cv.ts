import cv from "../data/cv.json" with { type: "json" };

export const CV = cv;

/** Compact and byte-stable across requests: fewer tokens, and the provider can cache the prompt prefix. */
export const CV_JSON = JSON.stringify(cv);

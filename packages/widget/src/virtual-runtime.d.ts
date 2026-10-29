declare module '*?audio-worklet' {
  /** URL of the self-contained `AudioWorkletProcessor` module. */
  const url: string;
  export default url;
}

declare module '*?audio-worklet-code' {
  /**
   * Self-contained, minified `AudioWorkletProcessor` script, ready to inline into a module that
   * loads it from a Blob URL at runtime.
   */
  const code: string;
  export default code;
}

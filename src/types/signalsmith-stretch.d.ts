declare module 'signalsmith-stretch' {
  export interface SignalsmithStretchSchedule {
    output?: number;
    outputTime?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }

  export interface SignalsmithStretchConfigure {
    preset?: 'default' | 'cheaper';
    blockMs?: number | null;
    intervalMs?: number;
    splitComputation?: boolean;
  }

  export interface SignalsmithStretchNode extends AudioWorkletNode {
    inputTime: number;
    start(
      when?: number | SignalsmithStretchSchedule,
      offset?: number,
      duration?: number,
      rate?: number,
      semitones?: number
    ): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    schedule(
      schedule: SignalsmithStretchSchedule,
      adjustPrevious?: boolean
    ): Promise<SignalsmithStretchSchedule>;
    addBuffers(sampleBuffers: Float32Array[], transfer?: Transferable[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<void | { start: number; end: number }>;
    clearBuffers(): Promise<{ start: number; end: number; dspReset: boolean }>;
    configure(config: SignalsmithStretchConfigure): Promise<unknown>;
    latency(): Promise<number>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>;
  }

  export default function SignalsmithStretch(
    audioContext: AudioContext,
    options?: AudioWorkletNodeOptions
  ): Promise<SignalsmithStretchNode>;
}

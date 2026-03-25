const DEFAULT_BUFFER_DEPTH = 4;
const MAX_SEQUENCE = 0xFFFF;
const FRAME_SIZE = 960;
const MAX_PLC_PER_DRAIN = 2;

class JitterBuffer {
  constructor(opusCodec, options = {}) {
    this._codec = opusCodec;
    this._bufferDepth = options.bufferDepth || DEFAULT_BUFFER_DEPTH;
    this._buffer = new Map();
    this._nextSequence = -1;
    this._outputQueue = [];
    this._fillCount = 0;
    this._filling = true;
    this._lostCount = 0;
    this._recoveredCount = 0;
    this._receivedCount = 0;
  }

  _seqDistance(a, b) {
    const diff = (a - b + MAX_SEQUENCE + 1) & MAX_SEQUENCE;
    return diff <= 0x8000 ? diff : diff - (MAX_SEQUENCE + 1);
  }

  push(sequence, opusData) {
    this._receivedCount++;

    if (this._nextSequence === -1) {
      this._nextSequence = sequence;
      this._filling = true;
      this._fillCount = 0;
    }

    const distance = this._seqDistance(sequence, this._nextSequence);
    if (distance < -this._bufferDepth * 2) {
      return;
    }

    this._buffer.set(sequence, opusData);

    if (this._filling) {
      this._fillCount++;
      if (this._fillCount >= this._bufferDepth) {
        this._filling = false;
        this._drain();
      }
    } else {
      this._drain();
    }
  }

  getFrames() {
    const frames = this._outputQueue;
    this._outputQueue = [];
    return frames;
  }

  _drain() {
    let plcEmitted = 0;
    let framesEmitted = 0;
    const maxFrames = this._bufferDepth * 2;

    while (framesEmitted < maxFrames) {
      const opusData = this._buffer.get(this._nextSequence);

      if (opusData) {
        this._buffer.delete(this._nextSequence);
        try {
          const pcm = this._codec.decode(opusData);
          this._outputQueue.push(pcm);
        } catch (err) {
          this._outputQueue.push(new Int16Array(FRAME_SIZE));
        }
        this._advanceSequence();
        framesEmitted++;
        plcEmitted = 0;
      } else if (this._buffer.size > 0 && plcEmitted < MAX_PLC_PER_DRAIN) {
        this._lostCount++;

        const nextSeq = (this._nextSequence + 1) & MAX_SEQUENCE;
        const nextPacket = this._buffer.get(nextSeq);

        if (nextPacket) {
          try {
            const recovered = this._codec.decodeFEC(nextPacket);
            this._outputQueue.push(recovered);
            this._recoveredCount++;
          } catch (e) {
            try {
              const plc = this._codec.decodePLC();
              this._outputQueue.push(plc);
            } catch (e2) {
              this._outputQueue.push(new Int16Array(FRAME_SIZE));
            }
          }
        } else {
          try {
            const plc = this._codec.decodePLC();
            this._outputQueue.push(plc);
          } catch (e) {
            this._outputQueue.push(new Int16Array(FRAME_SIZE));
          }
        }

        this._advanceSequence();
        framesEmitted++;
        plcEmitted++;
      } else {
        break;
      }
    }

    this._pruneOldPackets();
  }

  _advanceSequence() {
    this._nextSequence = (this._nextSequence + 1) & MAX_SEQUENCE;
  }

  _pruneOldPackets() {
    if (this._buffer.size > this._bufferDepth * 4) {
      const toDelete = [];
      for (const seq of this._buffer.keys()) {
        const dist = this._seqDistance(seq, this._nextSequence);
        if (dist < 0) {
          toDelete.push(seq);
        }
      }
      for (const seq of toDelete) {
        this._buffer.delete(seq);
      }
    }
  }

  reset() {
    this._buffer.clear();
    this._outputQueue = [];
    this._nextSequence = -1;
    this._filling = true;
    this._fillCount = 0;
  }

  get stats() {
    return {
      buffered: this._buffer.size,
      lost: this._lostCount,
      recovered: this._recoveredCount,
      received: this._receivedCount,
      filling: this._filling,
    };
  }
}

export { JitterBuffer, DEFAULT_BUFFER_DEPTH, FRAME_SIZE };

export class StreamingScrubber {
  private buffer = '';
  private insideTag = false;
  private readonly openTag = '<memory-context>';
  private readonly closeTag = '</memory-context>';

  scrub(chunk: string): string {
    let output = '';
    this.buffer += chunk;

    while (this.buffer.length > 0) {
      if (this.insideTag) {
        const closeIdx = this.buffer.indexOf(this.closeTag);
        if (closeIdx === -1) {
          if (this.buffer.length > 10000) {
            this.buffer = '';
            this.insideTag = false;
          }
          break;
        }
        this.buffer = this.buffer.slice(closeIdx + this.closeTag.length);
        this.insideTag = false;
        continue;
      }

      const openIdx = this.buffer.indexOf(this.openTag);
      if (openIdx === -1) {
        if (this.buffer.length > this.openTag.length) {
          const safe = this.buffer.length - this.openTag.length;
          output += this.buffer.slice(0, safe);
          this.buffer = this.buffer.slice(safe);
        }
        break;
      }

      output += this.buffer.slice(0, openIdx);
      this.buffer = this.buffer.slice(openIdx + this.openTag.length);
      this.insideTag = true;
    }

    return output;
  }

  flush(): string {
    if (this.insideTag) {
      this.buffer = '';
      this.insideTag = false;
      return '';
    }
    const remaining = this.buffer;
    this.buffer = '';
    return remaining;
  }

  reset(): void {
    this.buffer = '';
    this.insideTag = false;
  }
}

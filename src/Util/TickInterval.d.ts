/** # Tick Interval
 * Creates a predictable tick interval.
 */
export declare class TickInterval {
    stopOnError: boolean;
    private _active;
    private interval;
    private currentTimeout;
    private __timeoutFunc;
    constructor(run?: () => void | Promise<void>, interval?: number, stopOnError?: boolean);
    setOnRun(run: () => void | Promise<void>): this;
    setInterval(interval: number): this;
    private runInterval;
    start(): this;
    stop(): this;
}

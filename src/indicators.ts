export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

export function calcEma(closes: number[], period: number): number[] {
    if (closes.length < period) return [];
    
    const k = 2 / (period + 1);
    const result: number[] = [];
    
    // SMA для первой точки
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    let ema = sum / period;
    result.push(ema);

    // EMA для остальных
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] * k) + (ema * (1 - k));
        result.push(ema);
    }
    return result;
}

export function calcRsi(closes: number[], period: number = 14): number[] {
    if (closes.length < period + 1) return [];

    const changes = closes.slice(1).map((c, i) => c - closes[i]);
    const result: number[] = [];

    let gains = 0, losses = 0;
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) gains += changes[i];
        else losses -= changes[i];
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    const calculateRsi = (ag: number, al: number) => {
        if (al === 0) return 100;
        const rs = ag / al;
        return 100 - (100 / (1 + rs));
    };

    result.push(calculateRsi(avgGain, avgLoss));

    for (let i = period; i < changes.length; i++) {
        const change = changes[i];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        result.push(calculateRsi(avgGain, avgLoss));
    }
    return result;
}

export function calcBollinger(closes: number[], period: number = 20, stdMult: number = 2.0) {
    if (closes.length < period) return null;
    
    const slice = closes.slice(-period);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mid, 2), 0) / period;
    const std = Math.sqrt(variance);
    
    return {
        upper: mid + (stdMult * std),
        mid: mid,
        lower: mid - (stdMult * std)
    };
}
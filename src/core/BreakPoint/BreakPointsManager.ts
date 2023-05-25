import { FileLocation } from "../DebugCommand";

export interface ResolvedBreakPoint {
    id: number;
    line?: number;
    column?: number;
    verified: boolean;
}

export type RuntimeBreakPoint = ResolvedBreakPoint & FileLocation;

type FileBreakPointMapping = FileLocation & { id: number };
type BreakPointsList = Map<number, FileBreakPointMapping>;

/**
 * Manages BreakPointId <=> FileLocation Mappings
 */
export class BreakPointsManager {

    private breakPoints: BreakPointsList = new Map();

    private lastBreakpointId: number = 0;

    setBreakPoint(location: FileLocation): number {
        const id = this.lastBreakpointId;
        this.lastBreakpointId++;

        this.breakPoints.set(id, { id, ...location });

        return id;
    }

    removeBreakPoint(id: number) {
        this.breakPoints.delete(id);
    }

    removeAllBreakPoint(url: string) {
        const deleted = [];

        for (const [ id, bp ] of this.breakPoints) {
            if (bp.file === url) {
                deleted.push(id);
            }
        }

        for (const id of deleted) {
            this.breakPoints.delete(id);
        }
    }

    getBreakPointsList(loc: FileLocation): number[] {
        const hits = [];

        for (const [ id, bp ] of this.breakPoints) {
            if (bp.file === loc.file && bp.line === loc.line) {
                hits.push(id);
            }
        }

        return hits;
    }

    reset() {
        this.breakPoints.clear();
        this.lastBreakpointId = 0;
    }

    getBreakPoints(): BreakPointsList {
        return this.breakPoints;
    }
}

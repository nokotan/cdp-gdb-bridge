declare module "statikk" {

    import { Server } from "connect";
    import * as http from "http";

    export interface statikOption {
        port?: number;
        root?: string;
        coi?: boolean;
    }
    
    export interface launchedStatik {
        server: http.Server;
        app: Server;
        root: boolean;
        url: string;
    }
    
    export default function statik(ops: statikOption): launchedStatik;
    
}

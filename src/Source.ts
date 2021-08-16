export interface AddressMapping {
    line: number;
    address: number;
}

export class Source {
    mapping: AddressMapping[];

    constructor() {
        this.mapping = [];
    }
}
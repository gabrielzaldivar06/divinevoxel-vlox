import { SectorData } from "../../../index";
import { ArchivedSectorData } from "../../Types/index";
type RunData = {
    version?: number;
};
export default function ImportSector(archivedSector: ArchivedSectorData, archiveData: RunData): SectorData;
export {};

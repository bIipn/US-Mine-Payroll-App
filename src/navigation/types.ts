import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Auth: undefined;
  Main: undefined;
  Inspection: { equipmentId: string };
  InspectionResult: { inspectionId: string };
  InspectionDetail: { inspectionId: string };
  EndUse: { logId: string };
  MrfForm: { equipmentId?: string; inspectionId?: string };
  MrfDetail: { mrfId: string };
  ShiftDetail: { shiftId: string };
  Site: undefined;
  Standards: undefined;
  MyRecords: undefined;
  OnSite: undefined;
  TimeLogs: undefined;
  SafetyLog: undefined;
  MrfQueue: undefined;
  Payroll: undefined;
  PayrollEmployee: { employeeId: string; weekStart: number };
  Roster: undefined;
  Fleet: undefined;
};

export type TabParamList = {
  Clock: undefined;
  Equipment: undefined;
  Hours: undefined;
  Crew: undefined;
  More: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}

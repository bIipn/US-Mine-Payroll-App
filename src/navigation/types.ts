import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Auth: undefined;
  /** The tabs. Pass `screen` to land on one of them. */
  Main: NavigatorScreenParams<TabParamList> | undefined;
  Inspection: { equipmentId: string };
  InspectionResult: { inspectionId: string };
  InspectionDetail: { inspectionId: string };
  /** A person's equipment card for a day. With nothing passed it is your own, for today. */
  ChecklistCard: { employeeId?: string; day?: number } | undefined;
  EndUse: { logId: string };
  AreaExam: { sheetId: string };
  /** `fresh` is set straight after signing, to show what to do next. */
  AreaExamDetail: { examId: string; fresh?: boolean };
  AreaSheets: undefined;
  /** A request starts from a unit, from a Bad Order on a checklist, or from a line on an exam. */
  MrfForm: { equipmentId?: string; inspectionId?: string; examId?: string; findingKey?: string; location?: string };
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
  /** `start` is any day inside the pay period or workweek to open on. */
  PayrollEmployee: { employeeId: string; start: number; view: 'period' | 'week' };
  Roster: undefined;
  Fleet: undefined;
};

export type TabParamList = {
  Clock: undefined;
  /**
   * The Checklists tab. `tab` opens it on the equipment list or on the work
   * areas; `at` is the moment it was asked for, so asking twice works twice.
   */
  Equipment: { tab?: 'equipment' | 'area'; at?: number } | undefined;
  Hours: undefined;
  Crew: undefined;
  More: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // Tab names are included so a tab screen can jump to a sibling tab.
    interface RootParamList extends RootStackParamList, TabParamList {}
  }
}

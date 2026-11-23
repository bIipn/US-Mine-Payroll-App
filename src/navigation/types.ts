import type { NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  /** Signing in with an account kept on this phone: the first screen of a build with no server. */
  Auth: undefined;
  /**
   * Signing in to the company: its code, then a name and a passcode, or an email and a password. The
   * first screen of a build that connects to a company server (CAN_CONNECT), and only of one.
   */
  CompanySignIn: undefined;
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
  /** `tab` opens it on one of its three lists. */
  MyRecords: { tab?: 'cards' | 'exams' | 'requests' } | undefined;
  OnSite: undefined;
  TimeLogs: undefined;
  SafetyLog: undefined;
  MrfQueue: undefined;
  Payroll: undefined;
  /** `start` is any day inside the pay period or workweek to open on. */
  PayrollEmployee: { employeeId: string; start: number; view: 'period' | 'week' | 'month' };
  Roster: undefined;
  Fleet: undefined;
  Company: undefined;
  /** Signing this phone in to the company's server, and connecting it. Only in a build that names a server. */
  CompanyAccount: undefined;
  /**
   * Delete my account: the account on this phone, and the person's own company sign-in with it. With
   * `signInOnly`, from Company account: the company sign-in alone, with its password, and nothing of
   * whoever is signed in to the app.
   */
  DeleteAccount: { signInOnly?: true } | undefined;
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

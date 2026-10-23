import type { Vehicle } from './routing';
import { BOAT_M, TRUCK_M } from './params';

export type RoleId = 'rescue' | 'boat' | 'medic' | 'scout';

export interface Role {
  id: RoleId;
  name: string;
  emoji: string;
  blurb: string;
  /** people the team can carry */
  capacity: number;
  /** movement points per round */
  mp: number;
  truckLimit: number;
  boatMin: number;
  boatM: number;
  switchCost: number;
  canBoat: boolean;
  /** patients on board do not get worse, and any shelter will take them */
  medic: boolean;
}

export const ROLES: Record<RoleId, Role> = {
  rescue: { id: 'rescue', name: 'กู้ภัยกู้ชีพ', emoji: '🚒', blurb: 'รถใหญ่ รับได้ 6 คน', capacity: 6, mp: 8, truckLimit: 0.5, boatMin: 0.35, boatM: BOAT_M, switchCost: 1, canBoat: true, medic: false },
  boat: { id: 'boat', name: 'หน่วยเรือ', emoji: '🚤', blurb: 'เรือเร็ว ลงน้ำตื้นได้ สลับรถ-เรือฟรี', capacity: 4, mp: 8, truckLimit: 0.45, boatMin: 0.2, boatM: BOAT_M * 1.5, switchCost: 0, canBoat: true, medic: false },
  medic: { id: 'medic', name: 'อาสาพยาบาล', emoji: '🚑', blurb: 'ผู้ป่วยบนรถไม่ทรุด ส่งผู้ป่วยที่ศูนย์พักพิงได้', capacity: 4, mp: 8, truckLimit: 0.5, boatMin: 0.35, boatM: BOAT_M, switchCost: 1, canBoat: true, medic: true },
  scout: { id: 'scout', name: 'มอเตอร์ไซค์อาสา', emoji: '🏍️', blurb: 'วิ่งไกล +4 แต้ม แต่รับได้ 2 คนและลุยน้ำลึกไม่ได้', capacity: 2, mp: 12, truckLimit: 0.3, boatMin: 99, boatM: BOAT_M, switchCost: 1, canBoat: false, medic: false },
};

export const ROLE_LIST = Object.values(ROLES);

export const TEAM_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9'];
export const TEAM_NAMES = ['ทีมส้ม', 'ทีมฟ้า', 'ทีมเขียว', 'ทีมม่วง'];

export function vehicleOf(role: Role): Vehicle {
  return { truckLimit: role.truckLimit, boatMin: role.boatMin, truckM: TRUCK_M, boatM: role.boatM, switchCost: role.switchCost, canBoat: role.canBoat };
}

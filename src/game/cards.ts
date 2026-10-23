export interface CardEffect {
  /** multiplies this round's rain */
  rainMul?: number;
  /** multiplies the river inflow reached by the end of this round */
  inflowMul?: number;
  /** extra Songkhla Lake level, m */
  lakeAdd?: number;
  /** multiplies the storm-drain capacity this round */
  drainMul?: number;
  /** a canal bank gives way somewhere in the district (m³/s, hours) */
  surge?: { m3s: number; hours: number };
  /** closes random roads for a number of rounds */
  blocks?: { count: number; rounds: number; major?: boolean };
  clearBlocks?: boolean;
  /** movement points for every team this round */
  mpAll?: number;
  /** movement points for one random team this round */
  mpOne?: number;
  /** extra seats for one random team this round */
  capOne?: number;
  forecast?: 'hidden' | 'exact';
}

export interface CardDef {
  id: string;
  emoji: string;
  title: string;
  text: string;
  tone: 'bad' | 'good' | 'info';
  weight: number;
  effect: CardEffect;
}

export const CARDS: CardDef[] = [
  { id: 'cloudburst', emoji: '⛈️', title: 'ฝนถล่มหนักกว่าพยากรณ์', text: 'เมฆฝนก้อนใหญ่ลอยมาหยุดเหนือเมือง ฝนรอบนี้แรงขึ้น 35%', tone: 'bad', weight: 3, effect: { rainMul: 1.35 } },
  { id: 'river_surge', emoji: '🌊', title: 'น้ำเหนือหลากเข้าคลองอู่ตะเภา', text: 'น้ำจากเขาไหลลงมาเร็วกว่าที่คิด น้ำในคลองสิ้นรอบนี้เพิ่มขึ้น 25%', tone: 'bad', weight: 2.5, effect: { inflowMul: 1.25 } },
  { id: 'levee_breach', emoji: '🧱', title: 'คันกั้นน้ำริมคลองพัง!', text: 'น้ำทะลักออกมาท่วมย่านริมคลองภายในไม่กี่ชั่วโมง', tone: 'bad', weight: 1.5, effect: { surge: { m3s: 250, hours: 2.5 } } },
  { id: 'drain_clog', emoji: '🍂', title: 'ท่อระบายน้ำอุดตัน', text: 'ขยะและใบไม้ปิดปากท่อ น้ำฝนระบายได้แค่ 30% ของปกติรอบนี้', tone: 'bad', weight: 2, effect: { drainMul: 0.3 } },
  { id: 'tree_fall', emoji: '🌳', title: 'ต้นไม้ล้มขวางถนน', text: 'พายุทำต้นไม้ใหญ่ล้มปิดถนน 2 สาย ต้องรอเจ้าหน้าที่มาตัด 2 รอบ', tone: 'bad', weight: 2.5, effect: { blocks: { count: 2, rounds: 2 } } },
  { id: 'stalled_car', emoji: '🚗', title: 'รถเสียกลางถนนสายหลัก', text: 'รถยนต์ดับขวางถนนใหญ่ทั้งสองเลน 1 รอบ', tone: 'bad', weight: 2, effect: { blocks: { count: 1, rounds: 1, major: true } } },
  { id: 'power_out', emoji: '🔌', title: 'ไฟฟ้าดับทั้งย่าน', text: 'วิทยุและมือถือแบตหมด ไม่รู้พยากรณ์ฝนรอบนี้เลย!', tone: 'bad', weight: 1.5, effect: { forecast: 'hidden' } },
  { id: 'low_visibility', emoji: '🌫️', title: 'ฝนหนักจนมองแทบไม่เห็นทาง', text: 'ทุกทีมต้องขับช้าลง เสียแต้มเดิน 2', tone: 'bad', weight: 1.5, effect: { mpAll: -2 } },
  { id: 'lake_high', emoji: '🌅', title: 'ทะเลสาบสงขลาหนุนสูง', text: 'น้ำระบายลงทะเลสาบไม่ทัน ระดับน้ำปลายทางสูงขึ้น 30 ซม.', tone: 'bad', weight: 1, effect: { lakeAdd: 0.3 } },
  { id: 'rain_ease', emoji: '☀️', title: 'ฝนซาลงชั่วคราว', text: 'เมฆฝนเคลื่อนออกไปก่อน ฝนรอบนี้เบาลงครึ่งหนึ่ง', tone: 'good', weight: 2.5, effect: { rainMul: 0.5 } },
  { id: 'army_boat', emoji: '🚁', title: 'ทหารส่งเรือท้องแบนมาช่วย', text: 'ทีมหนึ่งทีม (สุ่ม) ได้เรือเพิ่ม วิ่งได้ไกลขึ้น +3 แต้มเดิน', tone: 'good', weight: 2, effect: { mpOne: 3 } },
  { id: 'donations', emoji: '📦', title: 'ถุงยังชีพบริจาคมาถึง', text: 'ชาวบ้านใจดีช่วยกันเติมน้ำมันและยกของขึ้นรถ ทุกทีม +1 แต้มเดิน', tone: 'good', weight: 2, effect: { mpAll: 1 } },
  { id: 'radio', emoji: '📻', title: 'วิทยุเตือนภัยรายงานละเอียด', text: 'ได้ข้อมูลฝนรอบนี้แม่นยำที่สุด ไม่มีคลาดเคลื่อน', tone: 'good', weight: 2, effect: { forecast: 'exact' } },
  { id: 'excavator', emoji: '🚜', title: 'รถแม็คโครเปิดทางให้', text: 'ถนนที่ถูกปิดอยู่ทั้งหมดกลับมาใช้ได้ทันที', tone: 'good', weight: 1.5, effect: { clearBlocks: true } },
  { id: 'volunteers', emoji: '🙋', title: 'อาสาสมัครมาช่วยเพิ่ม', text: 'ทีมหนึ่งทีม (สุ่ม) รับผู้ประสบภัยได้เพิ่ม +2 คนในรอบนี้', tone: 'good', weight: 2, effect: { capOne: 2 } },
  { id: 'calm', emoji: '🙂', title: 'ลมสงบ ไม่มีอะไรพิเศษ', text: 'รอบนี้ไม่มีเหตุการณ์แทรก ใช้เวลาวางแผนให้ดี', tone: 'info', weight: 2.5, effect: {} },
];

/** Flood-safety facts shown after each round (the game simplifies; real water is more dangerous). */
export const TIPS = [
  'น้ำไหลเชี่ยวสูงแค่ 15 ซม. ก็ทำให้ผู้ใหญ่เสียหลักล้มได้ — ในเกมรถผ่านได้ถึง 50 ซม. แต่ของจริงอย่าเสี่ยง',
  'น้ำลึก 30 ซม. ทำให้รถยนต์ส่วนใหญ่ลอยได้ ไม่ควรขับลุยถ้าไม่รู้ว่าน้ำลึกแค่ไหน',
  'ไฟฟ้ารั่วในน้ำท่วมอันตรายมาก ตัดสะพานไฟชั้นล่างก่อนน้ำเข้าบ้าน',
  'เตรียมถุงยังชีพ ยา เอกสารสำคัญ และไฟฉาย วางไว้ที่สูงที่หยิบง่าย',
  'จอดรถบนที่สูงก่อนน้ำมา — ในเกมทีมที่จอดในน้ำลึกจะรถดับและเสียแต้ม',
  'ผู้สูงอายุและผู้ป่วยติดเตียงควรย้ายก่อนน้ำจะมา อย่ารอให้น้ำเข้าบ้าน',
  'ติดตามประกาศของกรมอุตุนิยมวิทยาและ ปภ. อย่าเชื่อข่าวลือในโซเชียล',
  'ศูนย์พักพิงที่น้ำท่วมถึงก็ต้องปิดเหมือนกัน เลือกอาคารที่อยู่ที่สูงไว้เป็นทางเลือกสำรอง',
];

export const GIVEN_NAMES = ['สมชาย', 'สมศรี', 'มะลิ', 'ดวงใจ', 'บุญมี', 'แก้ว', 'ปราณี', 'อนันต์', 'ศิริ', 'วิชัย', 'นิตยา', 'ประสิทธิ์', 'สุนีย์', 'ธีระ', 'อรุณ', 'ลำดวน', 'พิกุล', 'สมปอง', 'จันทร์เพ็ญ', 'ชัยยา', 'นภา', 'วีระ', 'รัตนา', 'สุรชัย', 'มณี', 'ทองดี', 'สายใจ', 'กมล', 'พรทิพย์', 'ประเสริฐ'];

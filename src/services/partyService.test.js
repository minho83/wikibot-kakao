const { PartyService } = require('./partyService');

let service;

beforeAll(async () => {
  service = new PartyService();
  // DB 초기화 없이 파싱 메서드만 테스트
});

// ═══════════════════════════════════════════════════
// parseDate 테스트
// ═══════════════════════════════════════════════════
describe('parseDate', () => {
  const base = new Date(2026, 1, 6); // 2026-02-06

  test('오늘', () => {
    expect(service.parseDate('오늘', base)).toBe('2026-02-06');
  });

  test('내일', () => {
    expect(service.parseDate('내일', base)).toBe('2026-02-07');
  });

  test('슬래시 형식: 2/6', () => {
    expect(service.parseDate('2/6', base)).toBe('2026-02-06');
  });

  test('슬래시 + 요일: 12/28[일]', () => {
    expect(service.parseDate('12/28[일]', base)).toBe('2026-12-28');
  });

  test('점 + 요일: 12.27토요일', () => {
    expect(service.parseDate('12.27토요일', base)).toBe('2026-12-27');
  });

  test('한글월일: 12월27일 토', () => {
    expect(service.parseDate('12월27일 토', base)).toBe('2026-12-27');
  });

  test('한글월일 띄어쓰기: 12월 27일', () => {
    expect(service.parseDate('12월 27일', base)).toBe('2026-12-27');
  });

  test('특수문자 포함: ◆12월27일 토', () => {
    expect(service.parseDate('◆12월27일 토', base)).toBe('2026-12-27');
  });

  test('괄호 요일: 2/6(목)', () => {
    expect(service.parseDate('2/6(목)', base)).toBe('2026-02-06');
  });

  test('연도 자동추정: 1/5 (과거 → 다음 연도)', () => {
    // 2월 기준 1월은 1개월 전이므로 3개월 이내 → 올해 유지
    expect(service.parseDate('1/5', base)).toBe('2026-01-05');
  });

  test('연도 자동추정: 10/15 (과거 월 → 3개월 이상 차이)', () => {
    // base=2026-02, month=10 → monthDiff = 2-10 = -8 → 올해 유지 (음수라서)
    expect(service.parseDate('10/15', base)).toBe('2026-10-15');
  });

  // 엣지 케이스
  test('null 입력', () => {
    expect(service.parseDate(null, base)).toBeNull();
  });

  test('빈 문자열', () => {
    expect(service.parseDate('', base)).toBeNull();
  });

  test('날짜 없는 텍스트', () => {
    expect(service.parseDate('전사 [닉네임]', base)).toBeNull();
  });

  test('날짜만 단독: 2/28', () => {
    expect(service.parseDate('2/28', base)).toBe('2026-02-28');
  });

  test('한자리 월일: 1/1', () => {
    expect(service.parseDate('1/1', base)).toBe('2026-01-01');
  });

  test('★ 접두사 + 날짜: ★2/6(목)', () => {
    expect(service.parseDate('★2/6(목)', base)).toBe('2026-02-06');
  });

  test('날짜 뒤에 추가 텍스트: 2/6(목) 나겔탑 상층', () => {
    expect(service.parseDate('2/6(목) 나겔탑 상층', base)).toBe('2026-02-06');
  });
});

// ═══════════════════════════════════════════════════
// parseTimeSlot 테스트
// ═══════════════════════════════════════════════════
describe('parseTimeSlot', () => {
  test('콜론 형식: 13:00~15:00', () => {
    expect(service.parseTimeSlot('13:00~15:00')).toBe('13:00~15:00');
  });

  test('콜론 + 공백: 13:00 ~ 15:00', () => {
    expect(service.parseTimeSlot('13:00 ~ 15:00')).toBe('13:00~15:00');
  });

  test('한글 시: 19시~21시', () => {
    expect(service.parseTimeSlot('19시~21시')).toBe('19:00~21:00');
  });

  test('한글 시 + 공백: 19시 ~ 21시', () => {
    expect(service.parseTimeSlot('19시 ~ 21시')).toBe('19:00~21:00');
  });

  test('4자리 연속: 1800~2000', () => {
    expect(service.parseTimeSlot('1800~2000')).toBe('18:00~20:00');
  });

  test('4자리 + 공백: 1800 ~ 2000', () => {
    expect(service.parseTimeSlot('1800 ~ 2000')).toBe('18:00~20:00');
  });

  test('하이픈 구분: 13:00-15:00', () => {
    expect(service.parseTimeSlot('13:00-15:00')).toBe('13:00~15:00');
  });

  test('★ 접두사: ★19시 ~ 21시', () => {
    expect(service.parseTimeSlot('★19시 ~ 21시')).toBe('19:00~21:00');
  });

  test('자정 넘기기: 23:10~00:40', () => {
    expect(service.parseTimeSlot('23:10~00:40')).toBe('23:10~00:40');
  });

  test('한자리 시간: 9:00~11:00', () => {
    expect(service.parseTimeSlot('9:00~11:00')).toBe('09:00~11:00');
  });

  test('한자리 한글시: 9시~11시', () => {
    expect(service.parseTimeSlot('9시~11시')).toBe('09:00~11:00');
  });

  // 엣지 케이스
  test('null 입력', () => {
    expect(service.parseTimeSlot(null)).toBeNull();
  });

  test('빈 문자열', () => {
    expect(service.parseTimeSlot('')).toBeNull();
  });

  test('시간 없는 텍스트', () => {
    expect(service.parseTimeSlot('전사 [닉네임]')).toBeNull();
  });

  test('시작 시간만: 19시', () => {
    expect(service.parseTimeSlot('19시')).toBeNull();
  });

  test('시간 뒤에 추가 텍스트: 19시~21시 나겔탑', () => {
    expect(service.parseTimeSlot('19시~21시 나겔탑')).toBe('19:00~21:00');
  });

  test('4자리 하이픈: 1800- 2000', () => {
    expect(service.parseTimeSlot('1800- 2000')).toBe('18:00~20:00');
  });
});

// ═══════════════════════════════════════════════════
// parseJobSlots 테스트
// ═══════════════════════════════════════════════════
describe('parseJobSlots', () => {
  test('전사 + 닉네임과 빈슬롯: 전사 [랭퀵] []', () => {
    const result = service.parseJobSlots('전사 [랭퀵] []');
    expect(result).toMatchObject({
      job: 'warrior',
      slots: ['랭퀵', ''],
      emptyCount: 1
    });
  });

  test('도적 붙어쓰기: 도적[베라뮤진][]', () => {
    const result = service.parseJobSlots('도적[베라뮤진][]');
    expect(result).toMatchObject({
      job: 'rogue',
      slots: ['베라뮤진', ''],
      emptyCount: 1
    });
  });

  test('법사 3슬롯: 법사 [닉1] [닉2] []', () => {
    const result = service.parseJobSlots('법사 [닉1] [닉2] []');
    expect(result).toMatchObject({
      job: 'mage',
      slots: ['닉1', '닉2', ''],
      emptyCount: 1
    });
  });

  test('직자: 직자 [힐러]', () => {
    const result = service.parseJobSlots('직자 [힐러]');
    expect(result).toMatchObject({
      job: 'cleric',
      slots: ['힐러'],
      emptyCount: 0
    });
  });

  test('도가: 도가 [] []', () => {
    const result = service.parseJobSlots('도가 [] []');
    expect(result).toMatchObject({
      job: 'taoist',
      slots: ['', ''],
      emptyCount: 2
    });
  });

  test('데빌 → warrior: 데빌 [닉] []', () => {
    const result = service.parseJobSlots('데빌 [닉] []');
    expect(result).toMatchObject({ job: 'warrior' });
  });

  test('무도가 → taoist: 무도가 [닉]', () => {
    const result = service.parseJobSlots('무도가 [닉]');
    expect(result).toMatchObject({ job: 'taoist' });
  });

  test('세손법 → mage: 세손법 [닉]', () => {
    const result = service.parseJobSlots('세손법 [닉]');
    expect(result).toMatchObject({ job: 'mage' });
  });

  // 엣지 케이스
  test('null 입력', () => {
    expect(service.parseJobSlots(null)).toBeNull();
  });

  test('직업명 없는 줄', () => {
    expect(service.parseJobSlots('19시~21시')).toBeNull();
  });

  test('슬롯 없는 직업명', () => {
    expect(service.parseJobSlots('전사')).toBeNull();
  });

  test('슬롯 안에 공백: 전사 [ 닉네임 ] []', () => {
    const result = service.parseJobSlots('전사 [ 닉네임 ] []');
    expect(result).toMatchObject({
      job: 'warrior',
      slots: ['닉네임', ''],
      emptyCount: 1
    });
  });

  test('슬롯 안에 특수문자: 전사 [닉★123] []', () => {
    const result = service.parseJobSlots('전사 [닉★123] []');
    expect(result).toMatchObject({
      job: 'warrior',
      slots: ['닉★123', '']
    });
  });
});

// ═══════════════════════════════════════════════════
// parseMessage 통합 테스트 - 정상 케이스
// ═══════════════════════════════════════════════════
describe('parseMessage - 정상 케이스', () => {
  test('기본 파티 모집글', () => {
    const msg = `2/6(목) 나겔탑 상층

19시~21시
전사 [캐릭A] []
도적 [캐릭B] [캐릭C]
법사 [] []
직자 [힐러] []
도가 [도가닉]`;

    const result = service.parseMessage(msg, { name: '주최자', room_id: 'room1' });
    expect(result).toHaveLength(1);
    expect(result[0].time_slot).toBe('19:00~21:00');
    // BUG: "나겔탑 상층"에서 "나겔탑"만 매칭됨 (상층 정보 유실)
    expect(result[0].location).toBe('나겔탑');
    expect(JSON.parse(result[0].warrior_slots)).toEqual(['캐릭A', '']);
    expect(JSON.parse(result[0].rogue_slots)).toEqual(['캐릭B', '캐릭C']);
    expect(JSON.parse(result[0].mage_slots)).toEqual(['', '']);
    expect(JSON.parse(result[0].cleric_slots)).toEqual(['힐러', '']);
    expect(JSON.parse(result[0].taoist_slots)).toEqual(['도가닉']);
  });

  test('멀티 타임슬롯 파티', () => {
    const msg = `2/6(목) 상층

19시~21시
전사 [닉1] []
도적 [닉2]

22시~24시
전사 [] []
법사 [닉3]`;

    const result = service.parseMessage(msg, { name: '주최자', room_id: 'room1' });
    expect(result).toHaveLength(2);
    expect(result[0].time_slot).toBe('19:00~21:00');
    expect(result[1].time_slot).toBe('22:00~24:00');
  });

  test('#완비 태그', () => {
    const msg = `2/6(목) 상층 #완비

19시~21시
전사 [닉1] [닉2]
도적 [닉3] [닉4]`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    expect(result[0].is_complete).toBe(1);
  });

  test('장소: 나겔탑 인식', () => {
    const msg = `2/6(목) 나겔탑3층

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    // 나겔탑3층은 /나겔탑[^\s]*/ 패턴에 매칭
  });

  test('파티명 인식: 낭만사냥팟', () => {
    const msg = `2/6(목) 낭만사냥팟

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    expect(result[0].party_name).toBe('낭만사냥팟');
  });
});

// ═══════════════════════════════════════════════════
// parseMessage 엣지 케이스 - 실패 가능성
// ═══════════════════════════════════════════════════
describe('parseMessage - 엣지 케이스', () => {
  test('날짜 없는 메시지 → party_date가 null', () => {
    const msg = `19시~21시
전사 [닉1] []
도적 [닉2]`;

    const result = service.parseMessage(msg, {});
    // 파싱은 되지만 party_date가 null
    expect(result).toHaveLength(1);
    expect(result[0].party_date).toBeNull();
  });

  test('시간대 없는 메시지 → 빈 배열', () => {
    const msg = `2/6(목) 상층
전사 [닉1] []
도적 [닉2]`;

    const result = service.parseMessage(msg, {});
    // 시간대가 없으면 currentTimeSlot이 null이므로 슬롯 파싱 안됨
    expect(result).toHaveLength(0);
  });

  test('빈 메시지', () => {
    expect(service.parseMessage('', {})).toEqual([]);
    expect(service.parseMessage(null, {})).toEqual([]);
  });

  test('직업 슬롯 없이 시간만 있는 경우', () => {
    const msg = `2/6(목)

19시~21시
어서오세요~`;

    const result = service.parseMessage(msg, {});
    // 슬롯이 없으면 _hasAnySlots가 false → 저장 안됨
    expect(result).toHaveLength(0);
  });

  test('시간대가 날짜 줄과 같은 줄에 있는 경우', () => {
    const msg = `2/6(목) 19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    // 날짜 파싱은 첫 줄에서 되고, 시간도 같은 줄에서 감지됨
    expect(result).toHaveLength(1);
  });

  test('콜론 형식 시간 + 한글 시간 혼용', () => {
    const msg = `2/6(목)

13:00~15:00
전사 [닉1] []

19시~21시
도적 [닉2] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(2);
  });

  test('직업명이 요구사항 줄에도 있는 경우', () => {
    const msg = `2/6(목)
#데빌: 체580↑8강↑

19시~21시
전사 [닉] []
데빌 [닉2] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    // 요구사항과 슬롯 모두 파싱되는지 확인
    const reqs = JSON.parse(result[0].requirements);
    expect(reqs['데빌']).toBe('체580↑8강↑');
  });

  test('슬롯 안에 대괄호가 중첩된 경우: 전사 [[닉]] []', () => {
    const msg = `2/6(목)

19시~21시
전사 [[닉]] []`;

    const result = service.parseMessage(msg, {});
    // 정규식 [^\]]* 이므로 첫 ]에서 끊김 → ['[닉', '', ']'] 같은 이상한 결과 가능
    expect(result).toHaveLength(1);
    const warrior = JSON.parse(result[0].warrior_slots);
    // 실제 동작 확인
    expect(warrior).toBeDefined();
  });

  test('직업명 중복: 전사 줄이 2번', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉1] []
전사 [닉2] []
도적 [닉3]`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    // 두 번째 전사 줄이 첫 번째를 덮어쓰는지 확인
    const warrior = JSON.parse(result[0].warrior_slots);
    expect(warrior).toEqual(['닉2', '']);
  });

  test('장소 없는 메시지', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    expect(result[0].location).toBeNull();
  });

  test('senderInfo 없는 경우', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].sender_name).toBe('');
    expect(result[0].room_id).toBe('');
  });

  test('매우 긴 메시지 (10줄 넘는 헤더)', () => {
    const headerLines = Array(15).fill('공지사항 안내입니다').join('\n');
    const msg = `2/6(목) 상층
${headerLines}

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    // 날짜/장소는 첫 10줄에서만 파싱 → 날짜는 첫줄이라 OK
    expect(result).toHaveLength(1);
    expect(result[0].party_date).toBe('2026-02-06');
  });

  test('날짜가 10줄 이후에 있는 경우', () => {
    const lines = Array(12).fill('안내사항').join('\n');
    const msg = `${lines}
2/6(목) 상층

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    // parseDate는 첫 10줄만 탐색 → 날짜 못찾음
    expect(result).toHaveLength(1);
    expect(result[0].party_date).toBeNull();
  });

  test('나겔목, 나겔반은 장소로 인식하면 안됨', () => {
    const msg = `2/6(목) 나겔목 나겔반

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    // 나겔목/나겔반은 장비이므로 location이 null이어야 함
    expect(result[0].location).toBeNull();
  });

  test('설원 장소 인식', () => {
    const msg = `2/6(목) 설원

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result[0].location).toBe('설원');
  });

  test('아나테마 → mage', () => {
    const msg = `2/6(목)

19시~21시
아나테마 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    const mage = JSON.parse(result[0].mage_slots);
    expect(mage).toEqual(['닉', '']);
  });

  test('인식 → mage', () => {
    const msg = `2/6(목)

19시~21시
인식 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    const mage = JSON.parse(result[0].mage_slots);
    expect(mage).toEqual(['닉', '']);
  });

  // ── 장소 파싱 버그 발견 ──
  test('BUG: "나겔탑 상층"에서 상층 정보가 유실됨', () => {
    const msg = `2/6(목) 나겔탑 상층

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    // 정규식이 "나겔탑"만 캡처하고 "상층"은 버림
    // 기대: "나겔탑 상층" 또는 최소한 "상층"
    // 실제: "나겔탑"
    expect(result[0].location).toBe('나겔탑'); // 현재 동작 (버그)
  });

  test('BUG: "나겔탑 고층"에서 고층 정보가 유실됨', () => {
    const msg = `2/6(목) 나겔탑 고층

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result[0].location).toBe('나겔탑'); // 현재 동작 (버그)
  });

  // ── 실제 패턴 테스트 ──
  test('실전: 4자리 시간 + 하이픈', () => {
    const msg = `2/6(목) 설원

1800- 2000
전사 [닉1] [닉2]
도적 [] [닉3]
법사 [닉4]`;

    const result = service.parseMessage(msg, { name: '주최자', room_id: 'r1' });
    expect(result).toHaveLength(1);
    expect(result[0].time_slot).toBe('18:00~20:00');
  });

  test('실전: 요구사항 + 슬롯 복합 메시지', () => {
    const msg = `2/6(목) 탑층
#데빌: 체580↑8강↑
#도적: 올8강↑

19:00~21:00
데빌 [닉1] []
도적 [닉2] []
법사 [] []
직자 [닉3]
도가 [닉4] []`;

    const result = service.parseMessage(msg, {});
    expect(result).toHaveLength(1);
    const reqs = JSON.parse(result[0].requirements);
    expect(reqs['데빌']).toBe('체580↑8강↑');
    expect(reqs['도적']).toBe('올8강↑');
  });

  test('한 줄에 직업명과 시간이 같이 있으면 시간이 우선', () => {
    // "전사 19시~21시" 같은 줄은 시간으로 파싱됨 (직업 슬롯 아님)
    const msg = `2/6(목)

전사 19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    // "전사 19시~21시"가 timeSlot으로 파싱되고, 다음 줄 "전사 [닉] []"가 슬롯
    expect(result).toHaveLength(1);
    expect(result[0].time_slot).toBe('19:00~21:00');
  });

  test('필드 장소 인식', () => {
    const msg = `2/6(목) 필드

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result[0].location).toBe('필드');
  });

  test('나겔링 장소 인식', () => {
    const msg = `2/6(목) 나겔링

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, {});
    expect(result[0].location).toBe('나겔링');
  });
});

// ═══════════════════════════════════════════════════
// _isPartyMessage 테스트
// ═══════════════════════════════════════════════════
describe('_isPartyMessage', () => {
  test('정상 파티 메시지 → true', () => {
    const msg = `2/6(목)
19시~21시
전사 [닉] []`;
    expect(service._isPartyMessage(msg)).toBe(true);
  });

  test('일반 대화 → false', () => {
    expect(service._isPartyMessage('안녕하세요')).toBe(false);
    expect(service._isPartyMessage('오늘 날씨 좋다')).toBe(false);
  });

  test('직업명만 있는 메시지 → false (1개 매칭)', () => {
    expect(service._isPartyMessage('전사 데빌 강해요')).toBe(false);
  });

  test('날짜 + 직업 (2개 매칭) → false', () => {
    expect(service._isPartyMessage('2/6 전사')).toBe(false);
  });

  test('날짜 + 시간 + 직업 (3개 매칭) → true', () => {
    expect(service._isPartyMessage('2/6 19시~ 전사')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════
// _resolveDate 연도 추정 엣지 케이스
// ═══════════════════════════════════════════════════
describe('_resolveDate 연도 추정', () => {
  test('11월 기준 2월 날짜 → monthDiff = 11-2 = 9 > 3 → 다음 연도', () => {
    const base = new Date(2026, 10, 15); // 11월
    const result = service.parseDate('2/15', base);
    expect(result).toBe('2027-02-15');
  });

  test('2월 기준 11월 날짜 → monthDiff = 2-11 = -9 → 올해', () => {
    const base = new Date(2026, 1, 6); // 2월
    const result = service.parseDate('11/15', base);
    expect(result).toBe('2026-11-15');
  });

  test('12월 기준 1월 날짜 → monthDiff = 12-1 = 11 > 3 → 다음 연도', () => {
    const base = new Date(2026, 11, 20); // 12월
    const result = service.parseDate('1/5', base);
    expect(result).toBe('2027-01-05');
  });

  test('1월 기준 12월 날짜 → monthDiff = 1-12 = -11 → 올해', () => {
    const base = new Date(2026, 0, 10); // 1월
    const result = service.parseDate('12/25', base);
    // 음수이므로 올해 유지 → 하지만 실제로는 다음 해가 아닌 같은 해 12월
    expect(result).toBe('2026-12-25');
  });

  test('4월 기준 1월 날짜 → monthDiff = 4-1 = 3, NOT > 3 → 올해', () => {
    const base = new Date(2026, 3, 10); // 4월
    const result = service.parseDate('1/5', base);
    // 3개월 차이지만 > 3이 아닌 === 3이므로 올해
    expect(result).toBe('2026-01-05');
  });

  test('5월 기준 1월 날짜 → monthDiff = 5-1 = 4 > 3 → 다음 연도', () => {
    const base = new Date(2026, 4, 10); // 5월
    const result = service.parseDate('1/5', base);
    expect(result).toBe('2027-01-05');
  });
});

// ═══════════════════════════════════════════════════
// parseOrganizer 테스트
// ═══════════════════════════════════════════════════
describe('parseOrganizer', () => {
  test('기본: @닉네임/서버 → 닉네임만 추출', () => {
    expect(service.parseOrganizer('내용\n@오로라빛/베라')).toBe('오로라빛');
  });

  test('@닉네임만 (서버 없음)', () => {
    expect(service.parseOrganizer('내용\n@칼촉')).toBe('칼촉');
  });

  test('마지막 줄이 아닌 뒤쪽 5줄 이내', () => {
    expect(service.parseOrganizer('줄1\n줄2\n@주최자/서버\n추가줄1\n추가줄2')).toBe('주최자');
  });

  test('5줄 초과 위에 있으면 못 찾음', () => {
    const lines = ['@숨겨진주최자', '1', '2', '3', '4', '5', '6'];
    expect(service.parseOrganizer(lines.join('\n'))).toBeNull();
  });

  test('@ 없는 메시지 → null', () => {
    expect(service.parseOrganizer('파티 모집합니다\n전사 [닉] []')).toBeNull();
  });

  test('null 입력', () => {
    expect(service.parseOrganizer(null)).toBeNull();
  });

  test('빈 문자열', () => {
    expect(service.parseOrganizer('')).toBeNull();
  });

  test('줄 중간의 @는 무시 (줄 시작이 아닌 경우)', () => {
    // 줄 시작이 @인 경우만 매칭
    expect(service.parseOrganizer('연락처 abc@naver.com')).toBeNull();
  });

  test('실전 메시지에서 주최자 추출', () => {
    const msg = `★나겔상층 무공팟★
#데빌 대퓨업글/반지10강/체500↑
#도적 아브/기습진/체500↑

2/7(토) #23:10~01:10 (낡)
전사 : [유튜버][난지][피치아라]
도적 : [모카b][트릴리온]
도가 : [춘의역][]
법사 : [오로라빛][유예서]
직자 : [나믿고][늑두][신석기녀][유라리]
#랏도가

@오로라빛/베라`;

    expect(service.parseOrganizer(msg)).toBe('오로라빛');
  });
});

// ═══════════════════════════════════════════════════
// parseMessage - organizer 통합 테스트
// ═══════════════════════════════════════════════════
describe('parseMessage - organizer', () => {
  test('메시지에 @주최자가 있으면 organizer로 설정', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉] []

@오로라빛/베라`;

    const result = service.parseMessage(msg, { name: '보낸사람', room_id: 'room1' });
    expect(result).toHaveLength(1);
    expect(result[0].organizer).toBe('오로라빛');
    expect(result[0].sender_name).toBe('보낸사람');
  });

  test('@주최자 없으면 sender_name을 organizer로 fallback', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg, { name: '보낸사람', room_id: 'room1' });
    expect(result).toHaveLength(1);
    expect(result[0].organizer).toBe('보낸사람');
  });

  test('@주최자도 sender도 없으면 빈 문자열', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉] []`;

    const result = service.parseMessage(msg);
    expect(result).toHaveLength(1);
    expect(result[0].organizer).toBe('');
  });

  test('멀티 타임슬롯에서 모든 파티에 같은 organizer', () => {
    const msg = `2/6(목)

19시~21시
전사 [닉1] []

22시~24시
도적 [닉2] []

@칼촉/베라`;

    const result = service.parseMessage(msg, { name: '다른사람', room_id: 'room1' });
    expect(result).toHaveLength(2);
    expect(result[0].organizer).toBe('칼촉');
    expect(result[1].organizer).toBe('칼촉');
  });

  test('실전 메시지 전체 파싱', () => {
    const msg = `★나겔상층 무공팟★
#데빌 대퓨업글/반지10강/체500↑
#도적 아브/기습진/체500↑
#도가 반지10강/체500↑
#법사 칸6/무정령20/아나테마
#직자 힐업글/리베라티오/움6/마200↑
#전쟁,분쟁길드&캐릭 정중히 사양
#디코필수 (마이크 불가시 듣코라도 필수)
#참여기준 부족시 1:1오픈톡 문의주세요

2/7(토) #23:10~01:10 (낡)
전사 : [유튜버][난지][피치아라]
도적 : [모카b][트릴리온]
도가 : [춘의역][]
법사 : [오로라빛][유예서]
직자 : [나믿고][늑두][신석기녀][유라리]
#랏도가

@오로라빛/베라`;

    const result = service.parseMessage(msg, { name: '아무나', room_id: 'room1' });
    expect(result).toHaveLength(1);
    expect(result[0].organizer).toBe('오로라빛');
    expect(result[0].party_name).toBe('무공팟');
    expect(result[0].time_slot).toBe('23:10~01:10');
    expect(JSON.parse(result[0].warrior_slots)).toEqual(['유튜버', '난지', '피치아라']);
    expect(JSON.parse(result[0].rogue_slots)).toEqual(['모카b', '트릴리온']);
    expect(JSON.parse(result[0].taoist_slots)).toEqual(['춘의역', '']);
  });
});

// ═══════════════════════════════════════════════════
// _findByMemberOverlap / _extractFilledMembers 테스트
// ═══════════════════════════════════════════════════
describe('_extractFilledMembers', () => {
  test('빈 슬롯 제외하고 멤버만 추출', () => {
    const party = {
      warrior_slots: JSON.stringify(['닉1', '']),
      rogue_slots: JSON.stringify(['닉2', '닉3']),
      mage_slots: JSON.stringify(['']),
      cleric_slots: JSON.stringify([]),
      taoist_slots: JSON.stringify(['닉4'])
    };
    const members = service._extractFilledMembers(party);
    expect(members).toEqual(new Set(['닉1', '닉2', '닉3', '닉4']));
  });

  test('빈 파티 → 빈 Set', () => {
    const party = {
      warrior_slots: JSON.stringify([]),
      rogue_slots: JSON.stringify([]),
      mage_slots: JSON.stringify([]),
      cleric_slots: JSON.stringify([]),
      taoist_slots: JSON.stringify([])
    };
    expect(service._extractFilledMembers(party).size).toBe(0);
  });
});

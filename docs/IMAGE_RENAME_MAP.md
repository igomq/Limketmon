# LIMKETMON image rename map

2026-08-23 vision curation에서 기존 production version은 유지하고 파일명만 정규화했다. 모든 항목은 filesystem rename이며 이미지 바이트를 재인코딩하지 않았다.

| 이전 `images/` 파일명 | 현재 파일명 |
| --- | --- |
| `TalkMedia_i_0ad1e38c341b.jpg.jpg` | `limsingyu-v001.jpg` |
| `TalkMedia_i_0fdbeebb2b42.jpg.jpg` | `limsingyu-v002.jpg` |
| `TalkMedia_i_22a166cdc3ad.jpg.jpg` | `limsingyu-v003.jpg` |
| `TalkMedia_i_2a02ea79734f.jpg.jpg` | `limsingyu-v004.jpg` |
| `TalkMedia_i_2ba13c649260.jpg.jpg` | `limsingyu-v005.jpg` |
| `TalkMedia_i_2dc36a515a65.jpg.jpg` | `limsingyu-v006.jpg` |
| `TalkMedia_i_31cadc762444.jpg.jpg` | `limsingyu-v007.jpg` |
| `TalkMedia_i_32fcc88bfb7a.jpg.jpg` | `limsingyu-v008.jpg` |
| `TalkMedia_i_38e9bbd30314.jpg.jpg` | `limsingyu-v009.jpg` |
| `TalkMedia_i_3efcd6db0a3b.jpg.jpg` | `limsingyu-v010.jpg` |
| `TalkMedia_i_41157f4a0ce2.jpg.jpg` | `limsingyu-v011.jpg` |
| `TalkMedia_i_42eaaac1bbe7.jpg.jpg` | `limsingyu-v012.jpg` |
| `TalkMedia_i_4fcc9c18218e.jpg.jpg` | `limsingyu-v013.jpg` |
| `TalkMedia_i_5b2ef6a8d099.jpg.jpg` | `limsingyu-v014.jpg` |
| `TalkMedia_i_5bd9ee3e74c0.jpg.jpg` | `limsingyu-v015.jpg` |
| `TalkMedia_i_65b2980c2d23.jpg.jpg` | `limsingyu-v016.jpg` |
| `TalkMedia_i_6a052c5ab43a.jpg.jpg` | `limsingyu-v017.jpg` |
| `TalkMedia_i_6b53c52c5a00.jpg.jpg` | `limsingyu-v018.jpg` |
| `TalkMedia_i_6e0ccbdd3d37.jpg.jpg` | `limsingyu-v019.jpg` |
| `TalkMedia_i_84397a7b29c9.jpg.jpg` | `limsingyu-v020.jpg` |
| `TalkMedia_i_86990144af88.jpg.jpg` | `limsingyu-v021.jpg` |
| `TalkMedia_i_9013817979e2.jpg.jpg` | `limsingyu-v022.jpg` |
| `TalkMedia_i_9141631eb929.jpg.jpg` | `limsingyu-v023.jpg` |
| `TalkMedia_i_92ceaa020970.jpg.jpg` | `limsingyu-v024.jpg` |
| `TalkMedia_i_9e436f3c112f.jpg.jpg` | `limsingyu-v025.jpg` |
| `TalkMedia_i_a3251caca0cf.jpg.jpg` | `limsingyu-v026.jpg` |
| `TalkMedia_i_a4767723eeda.jpg.jpg` | `limsingyu-v027.jpg` |
| `TalkMedia_i_af51c422a2f7.jpg.jpg` | `limsingyu-v028.jpg` |
| `TalkMedia_i_c1a7d02f121d.jpg.jpg` | `limsingyu-v029.jpg` |
| `TalkMedia_i_c73643c464e4.jpg.jpg` | `limsingyu-v030.jpg` |
| `TalkMedia_i_cc69ca561413.jpg.jpg` | `limsingyu-v031.jpg` |
| `TalkMedia_i_d5704fabb76d.jpg.jpg` | `limsingyu-v032.jpg` |
| `TalkMedia_i_d6c5ea0da177.jpg.jpg` | `limsingyu-v033.jpg` |
| `TalkMedia_i_d82c2e6aa1aa.jpg.jpg` | `limsingyu-v034.jpg` |
| `TalkMedia_i_dd8209cd9de4.jpg.jpg` | `limsingyu-v035.jpg` |
| `TalkMedia_i_e6450b4fe72f.jpg.jpg` | `limsingyu-v036.jpg` |
| `TalkMedia_i_e6aeb643ccbe.jpg.jpg` | `limsingyu-v037.jpg` |
| `TalkMedia_i_e7e5d2c11892.jpg.jpg` | `limsingyu-v038.jpg` |
| `TalkMedia_i_e85474a5fd59.jpg.jpg` | `limsingyu-v039.jpg` |
| `TalkMedia_i_e93cd4512fc1.jpg.jpg` | `limsingyu-v040.jpg` |
| `TalkMedia_i_ea319d5223b9.jpg.jpg` | `limsingyu-v041.jpg` |
| `TalkMedia_i_f6bfaa72ebf8.jpg.jpg` | `limsingyu-v042.jpg` |
| `TalkMedia_i_f871d366f44a.jpg.jpg` | `limsingyu-v043.jpg` |
| `TalkMedia_i_fd2516ad1876.jpg.jpg` | `limsingyu-v044.jpg` |
| `TalkMedia_i_feab127b8c3f.jpg.jpg` | `limsingyu-v045.jpg` |
| `TalkMedia_i_3c207b102ae5.gif.gif` | `limsingyu-v046.gif` |

`public/cards/v001.jpg`–`v045.jpg`도 같은 version을 유지한 채 `public/cards/limsingyu-v001.jpg`–`limsingyu-v045.jpg`로 rename했다. v046 GIF 정적 사본은 `cards:sync`가 원본 바이트 그대로 생성한다.

export function drawingImportMessage(error){
 const message=String(error?.message??error);
 if(/Drawing id: string limit 128/.test(message))return '도형 id가 누락됐거나 문자열 형식·길이가 잘못됐습니다. JSON의 각 도형에 중복 없는 1~128자 id를 넣거나, 이 데모에서 저장한 원본 파일을 다시 불러오세요. 기존 차트와 도형은 유지됐습니다.';
 return '도형 파일을 불러오지 못했습니다: '+message.slice(0,160)+'. JSON v1, 존재하는 패널, 글꼴·색상과 파일 크기를 확인하거나 저장한 원본 파일로 복구하세요. 기존 차트와 도형은 유지됐습니다.';
}

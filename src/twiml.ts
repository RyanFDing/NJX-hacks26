export function forwardCall(toNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Connecting you now.</Say>
  <Dial>${toNumber}</Dial>
</Response>`;
}

export function startScreening(wsUrl: string, callerNumber: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Hi, please hold while I connect you.</Say>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callerNumber" value="${callerNumber}" />
    </Stream>
  </Connect>
</Response>`;
}

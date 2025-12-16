let waitingTimeout: NodeJS.Timeout | null = null;

const getWaitingTimeout = () => waitingTimeout;

const clearWaitingTimeout = () => {
  if (waitingTimeout) {
    clearTimeout(waitingTimeout);
    waitingTimeout = null;
  }
};

const setWaitingTimeout = (timeout: NodeJS.Timeout | null) => {
  waitingTimeout = timeout;
};

export { clearWaitingTimeout, getWaitingTimeout, setWaitingTimeout };

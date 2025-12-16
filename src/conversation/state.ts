let lastInvolved: number | null = null;
let ignoreCount = 0; // TODO:

const getLastInvolved = () => lastInvolved;
const setLastInvolved = (value: number | null) => {
  lastInvolved = value;
};

const getIgnoreCount = () => ignoreCount;
const setIgnoreCount = (value: number) => {
  ignoreCount = value;
};

export { getIgnoreCount, getLastInvolved, setIgnoreCount, setLastInvolved };

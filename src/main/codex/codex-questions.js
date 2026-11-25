const asyncCallId = /^call_[a-zA-Z0-9_-]{1,160}$/;
const tag = 'send_user_message_question_reply';
const wrapper = new RegExp('^<' + tag + '>\\s*([\\s\\S]*?)\\s*</' + tag + '>\\s*$');

function readAsyncQuestion(item) {
  if (item?.type !== 'agentMessage' || typeof item.id !== 'string' || !asyncCallId.test(item.id) ||
      !Array.isArray(item.questions) || !item.questions.length || item.questions.length > 10) return;
  const questions = [];
  for (const [index, question] of item.questions.entries()) {
    if (typeof question?.title !== 'string' || !question.title.trim() || question.title.length > 4000 ||
        question.options != null && (!Array.isArray(question.options) || question.options.length > 12 ||
          question.options.some(option => typeof option !== 'string' || !option.trim() || option.length > 1000))) return;
    const options = [...new Set(question.options || [])].map(label => ({ label }));
    questions.push({ id: String(index), question: question.title, options, allowCustom: true });
  }
  return { id: item.id, async: true, questions };
}

function readAsyncAnswers(text) {
  if (typeof text !== 'string' || text.length > 64000 || !text.startsWith('<' + tag + '>')) return;
  const match = wrapper.exec(text);
  if (!match) return;
  try {
    const values = JSON.parse(match[1]);
    if (!Array.isArray(values) || !values.length || values.length > 10) return;
    return values.map(({ questionItemId, answer }) => {
      const [tool, id, index, ...rest] = JSON.parse(questionItemId);
      if (tool !== 'request_user_input_async' || typeof id !== 'string' || !asyncCallId.test(id) || !Number.isInteger(index) ||
          index < 0 || index >= 10 || rest.length || typeof answer !== 'string') throw Error('Invalid question reply');
      return { id, index, answer };
    });
  } catch {}
}

function asyncQuestionInput(request, answers) {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) return;
  const replies = [];
  for (const question of request.questions) {
    const answer = answers.find(item => item?.id === question.id);
    if (!Array.isArray(answer?.selected)) return;
    const value = !answer.selected.length && typeof answer.custom === 'string' && answer.custom.length <= 4000
      ? answer.custom.trim() : answer.selected.length === 1 && !answer.custom &&
        question.options.some(option => option.label === answer.selected[0]) && answer.selected[0];
    if (!value) return;
    replies.push({
      questionItemId: JSON.stringify(['request_user_input_async', request.id, Number(question.id)]),
      question: question.question,
      answer: value,
    });
  }
  const text = '<' + tag + '>\n' + JSON.stringify(replies) + '\n</' + tag + '>\n';
  if (text.length > 64000) return;
  return [{ type: 'text', text, text_elements: [] }];
}

module.exports = { readAsyncQuestion, readAsyncAnswers, asyncQuestionInput };
